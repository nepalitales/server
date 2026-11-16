import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { authMiddleware } from "../../middleware/auth";
import { inventoryPrepQuerySchema } from "../../schemas";
import { formatZodErrors } from "../../utils";
import { getIstDateTime } from "../../lib/order-window";
import type { OrderDoc, ProductDoc, AddonDoc } from "../../types";

export const adminInventoryPrepRoutes = new Hono<AppBindings>();

adminInventoryPrepRoutes.use("*", authMiddleware);

/**
 * Calculates tomorrow's date string in IST format ("YYYY-MM-DD")
 */
function getTomorrowIstDateStr(): string {
  const { dateStr: todayStr } = getIstDateTime();
  const todayDate = new Date(`${todayStr}T12:00:00+05:30`);
  const tomorrowDate = new Date(todayDate.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(tomorrowDate);
  const getP = (t: string) =>
    tomorrowParts.find((p) => p.type === t)?.value || "";
  return `${getP("year")}-${getP("month")}-${getP("day")}`;
}

/**
 * GET /api/admin/inventory-prep
 *
 * Query params:
 * - date (optional, default: tomorrow in IST)
 *
 * Returns complete aggregated kitchen production plan & inventory requirements:
 * 1. Summary totals (orders, portions, veg/non-veg split, delivery vs pickup, add-ons)
 * 2. Item-by-item dish prep breakdown (portions, pieces estimate, slot needs)
 * 3. Add-on prep quantities (chutneys, sauces, sides)
 * 4. Slot/Batch schedule (morning vs evening cooking requirements)
 * 5. Customer dietary & special prep instructions
 * 6. Order roster for that specific dispatch date
 */
adminInventoryPrepRoutes.get("/", async (c) => {
  try {
    const parseResult = inventoryPrepQuerySchema.safeParse(c.req.query());
    if (!parseResult.success) {
      return c.json(
        {
          success: false,
          message: "Invalid query parameters",
          errors: formatZodErrors(parseResult.error),
        },
        400,
      );
    }

    const tomorrowStr = getTomorrowIstDateStr();
    const targetDate = parseResult.data.date || tomorrowStr;

    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const productsCol = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);
    const addonsCol = db.collection<AddonDoc>(COLLECTIONS.ADDONS);

    // Fetch orders, products, and addons in parallel
    const [rawOrders, allProducts, allAddons] = await Promise.all([
      ordersCol
        .find({
          dispatchDate: targetDate,
          status: { $nin: ["pending_payment", "expired"] },
        })
        .sort({ "dispatchSlot.start": 1, createdAt: 1 })
        .toArray(),
      productsCol.find({}).toArray(),
      addonsCol.find({}).toArray(),
    ]);

    // Create lookup map for products
    const productMap = new Map<string, ProductDoc>();
    for (const p of allProducts) {
      productMap.set(p.id, p);
      productMap.set(p.name.toLowerCase().trim(), p);
    }

    // Create lookup set for add-ons (chutneys, extra dips, chilli oil, etc.)
    const addonLookupSet = new Set<string>();
    for (const a of allAddons) {
      addonLookupSet.add(a.id);
      addonLookupSet.add(a.name.toLowerCase().trim());
    }

    // Separate confirmed vs cancelled orders
    const confirmedOrders = rawOrders.filter(
      (o) =>
        o.status !== "cancelled_by_customer" &&
        o.status !== "cancelled_by_admin",
    );
    const cancelledOrdersCount = rawOrders.length - confirmedOrders.length;

    // Aggregators
    const dishMap = new Map<
      string,
      {
        productId: string;
        productName: string;
        categorySlug?: string;
        type: "veg" | "non-veg";
        unitQuantity?: string;
        piecesPerPortion?: number;
        totalPortions: number;
        estimatedPieces?: number;
        orderCount: number;
        slots: Map<string, { slotLabel: string; quantity: number }>;
        revenue: number;
      }
    >();

    const addonMap = new Map<
      string,
      {
        addonId: string;
        name: string;
        totalQuantity: number;
        orderCount: number;
      }
    >();

    const slotMap = new Map<
      string,
      {
        slotId: string;
        slotLabel: string;
        start: string;
        end: string;
        orderCount: number;
        deliveryCount: number;
        pickupCount: number;
        dishes: Map<string, { productName: string; type: "veg" | "non-veg"; quantity: number }>;
      }
    >();

    const specialNotes: Array<{
      orderNumber: string;
      customerName: string;
      customerPhone: string;
      slotLabel: string;
      orderType: "pickup" | "delivery";
      note: string;
    }> = [];

    let totalPortions = 0;
    let vegPortions = 0;
    let nonVegPortions = 0;
    let totalAddons = 0;
    let deliveryOrders = 0;
    let pickupOrders = 0;
    let totalRevenue = 0;

    for (const order of confirmedOrders) {
      totalRevenue += order.totalAmount || 0;
      const isPickup = (order.orderType || "delivery") === "pickup";
      if (isPickup) {
        pickupOrders += 1;
      } else {
        deliveryOrders += 1;
      }

      // Slot details
      const slotId = order.dispatchSlot?.id || "unspecified";
      const slotLabel = order.dispatchSlot?.label || "Standard Slot";
      const slotStart = order.dispatchSlot?.start || "00:00";
      const slotEnd = order.dispatchSlot?.end || "23:59";

      if (!slotMap.has(slotId)) {
        slotMap.set(slotId, {
          slotId,
          slotLabel,
          start: slotStart,
          end: slotEnd,
          orderCount: 0,
          deliveryCount: 0,
          pickupCount: 0,
          dishes: new Map(),
        });
      }
      const slotData = slotMap.get(slotId)!;
      slotData.orderCount += 1;
      if (isPickup) slotData.pickupCount += 1;
      else slotData.deliveryCount += 1;

      // Special Customer Notes
      if (order.notes && order.notes.trim()) {
        specialNotes.push({
          orderNumber: order.orderNumber,
          customerName: order.customer.name,
          customerPhone: order.customer.phone,
          slotLabel,
          orderType: isPickup ? "pickup" : "delivery",
          note: order.notes.trim(),
        });
      }

      // Items aggregation
      for (const item of order.items || []) {
        const qty = item.quantity || 1;

        // Check if item is an add-on / condiment (chutney, dip, chilli oil, etc.)
        const isAddonItem =
          item.kind === "addon" ||
          Boolean(item.addonId) ||
          item.productId?.startsWith("addon_") ||
          addonLookupSet.has(item.productId) ||
          addonLookupSet.has(item.productName.toLowerCase().trim());

        if (isAddonItem) {
          totalAddons += qty;
          const aKey = item.addonId || item.productId || item.productName;
          if (!addonMap.has(aKey)) {
            addonMap.set(aKey, {
              addonId: item.addonId || item.productId,
              name: item.productName,
              totalQuantity: 0,
              orderCount: 0,
            });
          }
          const aData = addonMap.get(aKey)!;
          aData.totalQuantity += qty;
          aData.orderCount += 1;
        } else {
          // Food Dish (Momo, Jhol Momo, Shaphaley)
          totalPortions += qty;

          const product =
            productMap.get(item.productId) ||
            productMap.get(item.productName.toLowerCase().trim());

          const foodType: "veg" | "non-veg" =
            product?.type === "non-veg" ||
            item.productName.toLowerCase().includes("chicken")
              ? "non-veg"
              : "veg";

          if (foodType === "veg") {
            vegPortions += qty;
          } else {
            nonVegPortions += qty;
          }

          // Pieces per portion check (e.g. "8 pcs", "6 pcs")
          let piecesPerPortion: number | undefined;
          if (product?.quantity) {
            const match = product.quantity.match(/(\d+)\s*pcs/i);
            if (match && match[1]) piecesPerPortion = parseInt(match[1], 10);
          }

          const dishKey = item.productId || item.productName;
          if (!dishMap.has(dishKey)) {
            dishMap.set(dishKey, {
              productId: item.productId,
              productName: item.productName,
              categorySlug: product?.categorySlug,
              type: foodType,
              unitQuantity: product?.quantity,
              piecesPerPortion,
              totalPortions: 0,
              orderCount: 0,
              slots: new Map(),
              revenue: 0,
            });
          }

          const dishData = dishMap.get(dishKey)!;
          dishData.totalPortions += qty;
          dishData.orderCount += 1;
          dishData.revenue += item.subtotal || 0;

          // Slot tracking inside dish
          const currentSlotQty = dishData.slots.get(slotId)?.quantity || 0;
          dishData.slots.set(slotId, {
            slotLabel,
            quantity: currentSlotQty + qty,
          });

          // Dish tracking inside slot
          const currentSlotDish = slotData.dishes.get(dishKey);
          if (currentSlotDish) {
            currentSlotDish.quantity += qty;
          } else {
            slotData.dishes.set(dishKey, {
              productName: item.productName,
              type: foodType,
              quantity: qty,
            });
          }
        }

        // Addons aggregation from nested item.addons (if any)
        if (item.addons && item.addons.length > 0) {
          for (const addon of item.addons) {
            const aQty = (addon.quantity || 1) * qty;
            totalAddons += aQty;
            const aKey = addon.addonId || addon.name;
            if (!addonMap.has(aKey)) {
              addonMap.set(aKey, {
                addonId: addon.addonId,
                name: addon.name,
                totalQuantity: 0,
                orderCount: 0,
              });
            }
            const aData = addonMap.get(aKey)!;
            aData.totalQuantity += aQty;
            aData.orderCount += 1;
          }
        }
      }
    }

    // Format Dishes array (sorted by quantity descending)
    const dishes = Array.from(dishMap.values())
      .map((d) => ({
        productId: d.productId,
        productName: d.productName,
        categorySlug: d.categorySlug,
        type: d.type,
        unitQuantity: d.unitQuantity,
        totalPortions: d.totalPortions,
        estimatedPieces: d.piecesPerPortion
          ? d.totalPortions * d.piecesPerPortion
          : undefined,
        orderCount: d.orderCount,
        slots: Array.from(d.slots.entries()).map(([slotId, s]) => ({
          slotId,
          slotLabel: s.slotLabel,
          quantity: s.quantity,
        })),
        revenue: d.revenue,
      }))
      .sort((a, b) => b.totalPortions - a.totalPortions);

    // Format Addons array
    const addons = Array.from(addonMap.values())
      .sort((a, b) => b.totalQuantity - a.totalQuantity);

    // Format Slots array (sorted by start time)
    const slots = Array.from(slotMap.values())
      .map((s) => ({
        slotId: s.slotId,
        slotLabel: s.slotLabel,
        start: s.start,
        end: s.end,
        orderCount: s.orderCount,
        deliveryCount: s.deliveryCount,
        pickupCount: s.pickupCount,
        dishes: Array.from(s.dishes.values()).sort(
          (a, b) => b.quantity - a.quantity,
        ),
      }))
      .sort((a, b) => a.start.localeCompare(b.start));

    // Format Order Roster
    const orders = confirmedOrders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customer.name,
      customerPhone: o.customer.phone,
      orderType: o.orderType || "delivery",
      status: o.status,
      slotLabel: o.dispatchSlot?.label || "Standard Slot",
      slotStart: o.dispatchSlot?.start || "",
      itemsCount: (o.items || []).reduce((acc, it) => acc + (it.quantity || 1), 0),
      items: (o.items || []).map((it) => ({
        productName: it.productName,
        quantity: it.quantity,
        addons: it.addons?.map((a) => `${a.name} (x${a.quantity})`),
      })),
      notes: o.notes,
      totalAmount: o.totalAmount,
      deliveryAddress:
        (o.orderType || "delivery") === "pickup"
          ? "Kitchen Pickup"
          : o.deliveryAddress?.addressLine1 ||
            o.deliveryAddress?.street ||
            "Delivery",
    }));

    return c.json({
      success: true,
      date: targetDate,
      isTomorrow: targetDate === tomorrowStr,
      summary: {
        totalOrders: confirmedOrders.length,
        cancelledOrders: cancelledOrdersCount,
        totalPortions,
        vegPortions,
        nonVegPortions,
        deliveryOrders,
        pickupOrders,
        totalAddons,
        totalRevenue: Math.round(totalRevenue),
      },
      dishes,
      addons,
      slots,
      specialNotes,
      orders,
    });
  } catch (error: any) {
    console.error("[Admin Inventory Prep Error]:", error);
    return c.json(
      {
        success: false,
        message: "Failed to generate inventory prep plan: " + (error?.message || "Unknown error"),
      },
      500,
    );
  }
});
