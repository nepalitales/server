import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { generateId } from "../../lib/crypto";
import { checkOrderWindow } from "../../lib/order-window";
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
  initiateRazorpayRefund,
} from "../../lib/razorpay";
import { formatBorzoAddress } from "./address";
import { recordOrderEvent } from "../../lib/order-events";
import {
  sendOrderConfirmationEmail,
  sendOrderStatusEmail,
} from "../../lib/email";
import { generateOrderInvoicePdf } from "../../lib/pdf-invoice";
import { getOrderSettings } from "../../lib/order-settings";
import { createOrderSchema, verifyPaymentSchema, MAX_DISHES_PER_ORDER } from "../../schemas";
import { formatZodErrors } from "../../utils";
import { clientAuthMiddleware } from "../../middleware/client-auth";
import {
  getTomorrowIstDate,
  getNextAvailableDispatchDate,
  reserveSlotAtomically,
  confirmSlotReservation,
  releaseSlotReservation,
} from "../../lib/dispatch-windows";
import { getRedisClient } from "../../lib/redis";
import { generateNextOrderNumber } from "../../lib/order-sequence";
import type {
  OrderDoc,
  OrderItem,
  ProductDoc,
  AddonDoc,
  ClientAddressDoc,
  ClientUserDoc,
  OrderItemAddon,
} from "../../types";

const clientOrderRoutes = new Hono<AppBindings>();

// All customer order routes require authentication
clientOrderRoutes.use("*", clientAuthMiddleware);

const MAX_ADDONS_PER_ORDER = 20;

// ─── 1. Create Order & Initiate Payment ───────────────────────────

/**
 * POST /api/client/orders
 *
 * Checks ordering window, validates cart items against live product prices,
 * resolves customer address, creates order with status "pending_payment",
 * and initiates a Razorpay checkout order.
 */
clientOrderRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createOrderSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid order data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const db = c.get("db");
    const isDev = c.env.NODE_ENV === "development";

    // 1. Check Ordering Window strictly against real-life schedule
    const windowCheck = await checkOrderWindow(db, false);
    if (!windowCheck.isOpen) {
      return c.json(
        {
          success: false,
          message: windowCheck.message,
          windowDetails: windowCheck,
        },
        403,
      );
    }

    const userId = c.get("userId")!;
    const user = c.get("user") as ClientUserDoc;
    const orderType = parsed.data.orderType;
    const settings = await getOrderSettings(db);

    if (orderType === "pickup" && !settings.pickupEnabled) {
      return c.json({ success: false, message: "Pickup is currently unavailable" }, 400);
    }
    if (orderType === "delivery" && !settings.deliveryEnabled) {
      return c.json({ success: false, message: "Delivery is currently unavailable" }, 400);
    }

    const customerEmail = (parsed.data.contactEmail || user.email || "").toLowerCase().trim();
    if (!customerEmail) {
      return c.json(
        {
          success: false,
          message: "Please sign in with your email before placing an order.",
        },
        400,
      );
    }

    // 2. Validate Dish Limits (Max 15 dishes per order)
    const requestedDishesCount = parsed.data.items.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );

    if (requestedDishesCount > MAX_DISHES_PER_ORDER) {
      return c.json(
        {
          success: false,
          message: `You can order at most ${MAX_DISHES_PER_ORDER} dishes in a single order (requested: ${requestedDishesCount}).`,
        },
        400,
      );
    }

    // 3. Resolve Delivery Address (required for delivery; kitchen snapshot for pickup)
    const addressCol = db.collection<ClientAddressDoc>(COLLECTIONS.CLIENT_ADDRESSES);
    let addressDoc: ClientAddressDoc | null = null;

    if (orderType === "delivery") {
      if (parsed.data.addressId) {
        addressDoc = await addressCol.findOne({ id: parsed.data.addressId, userId });
        if (!addressDoc) {
          return c.json({ success: false, message: "Selected address not found" }, 404);
        }
      } else if (parsed.data.address) {
        const flatNumber = parsed.data.address.flatNumber || parsed.data.address.apartment || "";
        const wing = parsed.data.address.wing || "";
        const addressLine1 = parsed.data.address.addressLine1 || parsed.data.address.building || "";
        const addressLine2 = parsed.data.address.addressLine2 || parsed.data.address.street || "";
        const landmark = parsed.data.address.landmark || "";
        const city = parsed.data.address.city || "Mumbai";
        const pincode = parsed.data.address.pincode || "";

        const newAddr: ClientAddressDoc = {
          id: generateId("addr"),
          userId,
          label: parsed.data.address.label || "Home",
          flatNumber,
          wing,
          addressLine1,
          addressLine2,
          street: addressLine2 || addressLine1 || parsed.data.address.street || "",
          building: addressLine1 || parsed.data.address.building || "",
          apartment: flatNumber || parsed.data.address.apartment || "",
          floor: parsed.data.address.floor,
          landmark,
          city,
          pincode,
          latitude: parsed.data.address.latitude,
          longitude: parsed.data.address.longitude,
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await addressCol.insertOne(newAddr as any);
        addressDoc = newAddr;
      }

      if (!addressDoc) {
        return c.json({ success: false, message: "Valid delivery address is required" }, 400);
      }
    } else {
      addressDoc = {
        id: "pickup_kitchen",
        userId,
        label: "Pickup",
        street: c.env.KITCHEN_ADDRESS,
        city: "Thane",
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    // 4. Resolve & Price Cart Items + Add-ons
    const productCol = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);
    const addonCol = db.collection<AddonDoc>(COLLECTIONS.ADDONS);
    const requestedProductIds = parsed.data.items.map((i) => i.productId);
    const nestedAddonIds = parsed.data.items.flatMap(
      (i) => i.addons?.map((a) => a.addonId) ?? [],
    );
    const standaloneAddonIds = parsed.data.addons?.map((a) => a.addonId) ?? [];
    const allAddonIds = [...new Set([...nestedAddonIds, ...standaloneAddonIds])];

    const [products, addonDocs] = await Promise.all([
      productCol.find({ id: { $in: requestedProductIds } }).toArray(),
      allAddonIds.length
        ? addonCol.find({ id: { $in: allAddonIds } }).toArray()
        : Promise.resolve([] as AddonDoc[]),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p]));
    const addonMap = new Map(addonDocs.map((a) => [a.id, a]));
    const orderItems: OrderItem[] = [];
    let itemTotal = 0;

    const resolveAddonLines = (
      entries: { addonId: string; quantity: number }[],
    ): { error?: string; lines: OrderItemAddon[] } => {
      const lines: OrderItemAddon[] = [];
      for (const entry of entries) {
        const addon = addonMap.get(entry.addonId);
        if (!addon) {
          return { error: `Add-on with ID '${entry.addonId}' not found`, lines: [] };
        }
        if (!addon.isAvailable) {
          return { error: `Add-on '${addon.name}' is currently unavailable`, lines: [] };
        }
        const subtotal = addon.price * entry.quantity;
        lines.push({
          addonId: addon.id,
          name: addon.name,
          price: addon.price,
          quantity: entry.quantity,
          subtotal,
          image: addon.image,
        });
      }
      return { lines };
    };

    for (const item of parsed.data.items) {
      const product = productMap.get(item.productId);
      if (!product) {
        return c.json(
          { success: false, message: `Product with ID '${item.productId}' not found` },
          404,
        );
      }
      if (!product.isAvailable) {
        return c.json(
          {
            success: false,
            message: `Product '${product.name}' is currently unavailable`,
          },
          400,
        );
      }

      const subtotal = product.price * item.quantity;
      itemTotal += subtotal;

      let attachedAddons: OrderItemAddon[] | undefined;
      if (item.addons?.length) {
        const resolved = resolveAddonLines(item.addons);
        if (resolved.error) {
          return c.json({ success: false, message: resolved.error }, 400);
        }
        attachedAddons = resolved.lines;
        itemTotal += resolved.lines.reduce((sum, line) => sum + line.subtotal, 0);
      }

      orderItems.push({
        productId: product.id,
        productName: product.name,
        price: product.price,
        quantity: item.quantity,
        subtotal,
        image: product.image,
        kind: "product",
        ...(attachedAddons?.length ? { addons: attachedAddons } : {}),
      });
    }

    if (parsed.data.addons?.length) {
      if (parsed.data.addons.length > MAX_ADDONS_PER_ORDER) {
        return c.json({ success: false, message: "Too many add-ons in this order" }, 400);
      }
      const resolved = resolveAddonLines(parsed.data.addons);
      if (resolved.error) {
        return c.json({ success: false, message: resolved.error }, 400);
      }
      for (const line of resolved.lines) {
        itemTotal += line.subtotal;
        orderItems.push({
          productId: line.addonId,
          addonId: line.addonId,
          productName: line.name,
          price: line.price,
          quantity: line.quantity,
          subtotal: line.subtotal,
          image: line.image,
          kind: "addon",
        });
      }
    }

    const deliveryFee = orderType === "delivery" ? settings.deliveryFee : 0;
    const discount = 0;
    const totalAmount = itemTotal + deliveryFee - discount;

    // 5. Generate Order Number & Reserve Dispatch Slot Atomically
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const redis = getRedisClient(c.env);
    const orderNumber = await generateNextOrderNumber(db, redis);
    const orderId = generateId("order");

    const targetDispatchDate =
      parsed.data.dispatchDate || (await getNextAvailableDispatchDate(db)).dateStr;

    // ATOMIC RESERVATION LOCK: Prevents race conditions during concurrent checkouts
    const reservation = await reserveSlotAtomically(db, {
      dateStr: targetDispatchDate,
      slotId: parsed.data.dispatchSlotId,
      orderId,
    });

    if (!reservation.success) {
      return c.json(
        {
          success: false,
          message: reservation.message,
          reason: reservation.reason,
        },
        409,
      );
    }

    // 6. Initiate Razorpay Checkout Order
    const razorpayOrder = await createRazorpayOrder({
      amountInInr: totalAmount,
      receiptId: orderId,
      keyId: c.env.RAZORPAY_KEY_ID,
      keySecret: c.env.RAZORPAY_KEY_SECRET,
      isDevelopment: isDev,
    });

    if (!razorpayOrder.success) {
      // Release reservation hold immediately if payment gateway init fails
      await releaseSlotReservation(db, {
        dateStr: reservation.dispatchDate,
        slotId: reservation.slot.id,
        orderId,
      });
      return c.json(
        { success: false, message: "Failed to initiate payment gateway" },
        500,
      );
    }

    // Customer cancellation allowed until end of order window
    const canCustomerCancelUntil =
      windowCheck.canCancelUntil || new Date(Date.now() + 2 * 60 * 60 * 1000);

    const orderDoc: OrderDoc = {
      id: orderId,
      orderNumber,
      userId,
      customer: {
        name: parsed.data.customerName?.trim() || user.username || "Customer",
        phone: parsed.data.contactPhone || user.phone || "",
        email: customerEmail,
      },
      orderType,
      deliveryAddress: {
        id: addressDoc.id,
        label: addressDoc.label,
        flatNumber: addressDoc.flatNumber,
        wing: addressDoc.wing,
        addressLine1: addressDoc.addressLine1,
        addressLine2: addressDoc.addressLine2,
        street: addressDoc.street,
        building: addressDoc.building,
        floor: addressDoc.floor,
        apartment: addressDoc.apartment,
        landmark: addressDoc.landmark,
        city: addressDoc.city,
        pincode: addressDoc.pincode,
        latitude: addressDoc.latitude,
        longitude: addressDoc.longitude,
        borzoFormat:
          orderType === "pickup"
            ? {
                address: c.env.KITCHEN_ADDRESS,
                note: settings.pickupInstructions,
              }
            : formatBorzoAddress(addressDoc),
      },
      items: orderItems,
      itemTotal,
      deliveryFee,
      discount,
      totalAmount,
      notes: parsed.data.notes?.trim(),
      status: "pending_payment",
      canCustomerCancelUntil,
      dispatchDate: reservation.dispatchDate,
      dispatchSlot: {
        id: reservation.slot.id,
        start: reservation.slot.start,
        end: reservation.slot.end,
        label: reservation.slot.label,
      },
      slotHoldExpiresAt: reservation.expiresAt,
      payment: {
        provider: "razorpay",
        razorpayOrderId: razorpayOrder.razorpayOrderId,
        status: "pending",
      },
      timeline: [
        {
          status: "pending_payment",
          timestamp: new Date(),
          note: "Order created, awaiting payment verification",
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await ordersCol.insertOne(orderDoc as any);

    // Keep user's profile synced in client_users
    try {
      const usersCol = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);
      const currentUser = await usersCol.findOne({ id: userId });
      if (currentUser) {
        const updateFields: Record<string, unknown> = {};
        if (!currentUser.username && parsed.data.customerName) {
          updateFields.username = parsed.data.customerName.trim();
        }
        if (!currentUser.phone && parsed.data.contactPhone) {
          updateFields.phone = parsed.data.contactPhone.trim();
        }
        if (Object.keys(updateFields).length > 0) {
          updateFields.updatedAt = new Date();
          await usersCol.updateOne({ id: userId }, { $set: updateFields });
        }
      }
    } catch (e) {
      console.warn("[Orders] Non-fatal user profile sync error:", e);
    }

    return c.json(
      {
        success: true,
        message: "Order created successfully. Proceed to payment.",
        order: {
          id: orderDoc.id,
          orderNumber: orderDoc.orderNumber,
          totalAmount: orderDoc.totalAmount,
          orderType: orderDoc.orderType,
          itemTotal: orderDoc.itemTotal,
          deliveryFee: orderDoc.deliveryFee,
          status: orderDoc.status,
          canCustomerCancelUntil: orderDoc.canCustomerCancelUntil,
        },
        payment: {
          provider: "razorpay",
          razorpayOrderId: razorpayOrder.razorpayOrderId,
          amount: razorpayOrder.amount,
          currency: razorpayOrder.currency,
          keyId: c.env.RAZORPAY_KEY_ID || "mock_key_id",
          isSimulated: razorpayOrder.isSimulated,
        },
      },
      201,
    );
  } catch (error) {
    console.error("Create client order error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 2. Verify Payment & Confirm Order ─────────────────────────────

/**
 * POST /api/client/orders/verify-payment
 *
 * Verifies Razorpay payment signature. Transitions order to "placed",
 * sends a Resend confirmation email, and broadcasts a live event to the admin dashboard.
 */
clientOrderRoutes.post("/verify-payment", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = verifyPaymentSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid payment verification data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;
    const userId = c.get("userId")!;
    const db = c.get("db");
    const isDev = c.env.NODE_ENV === "development";

    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const order = await ordersCol.findOne({ id: orderId, userId });

    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    if (order.status !== "pending_payment") {
      // If Razorpay Webhook already confirmed payment, return idempotent success
      if (order.status === "placed" && order.payment?.status === "paid") {
        return c.json({
          success: true,
          message: "Payment already verified and confirmed.",
          order,
        });
      }

      return c.json(
        {
          success: false,
          message: `Order is already in '${order.status}' status.`,
          order,
        },
        400,
      );
    }

    // Verify signature
    const isValid = await verifyRazorpaySignature({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      keySecret: c.env.RAZORPAY_KEY_SECRET,
      isDevelopment: isDev,
    });

    if (!isValid) {
      await ordersCol.updateOne(
        { id: orderId },
        {
          $set: {
            "payment.status": "failed",
            updatedAt: new Date(),
          },
        },
      );
      return c.json(
        { success: false, message: "Payment signature verification failed" },
        400,
      );
    }

    // Update to placed
    const now = new Date();
    await ordersCol.updateOne(
      { id: orderId },
      {
        $set: {
          status: "placed",
          "payment.status": "paid",
          "payment.razorpayPaymentId": razorpayPaymentId,
          "payment.razorpaySignature": razorpaySignature,
          "payment.paidAt": now,
          updatedAt: now,
        },
        $push: {
          timeline: {
            status: "placed",
            timestamp: now,
            note: "Payment verified successfully. Order confirmed.",
          },
        } as any,
      },
    );

    // Confirm slot reservation permanently
    if (order.dispatchDate && order.dispatchSlot?.id) {
      await confirmSlotReservation(db, {
        dateStr: order.dispatchDate,
        slotId: order.dispatchSlot.id,
        orderId: order.id,
      });
    }

    const updatedOrder = await ordersCol.findOne({ id: orderId });

    // Send itemized order confirmation email via Resend
    sendOrderConfirmationEmail({
      order: updatedOrder || order,
      apiKey: c.env.RESEND_API_KEY,
      fromEmail: c.env.RESEND_FROM_EMAIL,
      adminEmail: c.env.ADMIN_NOTIFICATION_EMAIL,
      isDevelopment: isDev,
    }).catch((e) => console.error("Failed to send order confirmation email:", e));

    // Broadcast Real-Time SSE event to Admin Dashboard
    await recordOrderEvent(db, {
      type: "order_created",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "placed",
      summary: {
        totalAmount: order.totalAmount,
        customerName: order.customer.name,
        customerPhone: order.customer.phone,
        itemsCount: order.items.length,
      },
    });

    return c.json({
      success: true,
      message: "Payment verified and order confirmed!",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Verify payment error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 3. List Customer Orders ──────────────────────────────────────

/**
 * GET /api/client/orders
 *
 * Returns all past and active orders for the authenticated customer.
 */
clientOrderRoutes.get("/", async (c) => {
  try {
    const userId = c.get("userId")!;
    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const orders = await ordersCol
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    return c.json({
      success: true,
      orders,
      count: orders.length,
    });
  } catch (error) {
    console.error("List customer orders error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 4. Get Single Order & Live Tracking ──────────────────────────

/**
 * GET /api/client/orders/:orderId
 *
 * Retrieves single order details along with live Borzo courier tracking URL.
 */
clientOrderRoutes.get("/:orderId", async (c) => {
  try {
    const orderId = c.req.param("orderId");
    const userId = c.get("userId")!;
    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const order = await ordersCol.findOne({ id: orderId, userId });

    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    const canCancel =
      order.status === "placed" && new Date() <= new Date(order.canCustomerCancelUntil);

    return c.json({
      success: true,
      order,
      canCancel,
      trackingUrl: order.borzo?.trackingUrl || null,
    });
  } catch (error) {
    console.error("Get customer order error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 4b. Download Customer PDF Invoice ────────────────────────────

/**
 * GET /api/client/orders/:orderId/invoice.pdf
 *
 * Stream official PDF invoice document for the authenticated customer.
 */
clientOrderRoutes.get("/:orderId/invoice.pdf", async (c) => {
  try {
    const orderId = c.req.param("orderId");
    const userId = c.get("userId")!;
    const db = c.get("db");

    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const order = await ordersCol.findOne({ id: orderId, userId });

    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    const pdfBytes = await generateOrderInvoicePdf(order);

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Invoice_${order.orderNumber}.pdf"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Generate customer invoice PDF error:", error);
    return c.json({ success: false, message: "Failed to generate invoice PDF" }, 500);
  }
});

// ─── 5. Cancel Order (Before Window Closes) ────────────────────────

/**
 * POST /api/client/orders/:orderId/cancel
 *
 * Customer cancellation endpoint.
 * Allowed ONLY if order is in "placed" status and before the ordering window closes.
 * Automatically initiates full Razorpay refund.
 */
clientOrderRoutes.post("/:orderId/cancel", async (c) => {
  try {
    const orderId = c.req.param("orderId");
    const userId = c.get("userId")!;
    const db = c.get("db");
    const isDev = c.env.NODE_ENV === "development";

    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const order = await ordersCol.findOne({ id: orderId, userId });

    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    if (order.status !== "placed" && order.status !== "pending_payment") {
      return c.json(
        {
          success: false,
          message: `Cannot cancel order in '${order.status}' status.`,
        },
        400,
      );
    }

    // Check cancellation window
    const now = new Date();
    if (now > new Date(order.canCustomerCancelUntil)) {
      return c.json(
        {
          success: false,
          message:
            "Cancellation window has expired. The order window has closed and the kitchen has begun preparation.",
          canCustomerCancelUntil: order.canCustomerCancelUntil,
        },
        400,
      );
    }

    // Process refund if payment was paid
    let refundResult = null;
    if (order.payment.status === "paid" && order.payment.razorpayPaymentId) {
      refundResult = await initiateRazorpayRefund({
        paymentId: order.payment.razorpayPaymentId,
        amountInInr: order.totalAmount,
        reason: "Cancelled by customer before ordering window closed",
        keyId: c.env.RAZORPAY_KEY_ID,
        keySecret: c.env.RAZORPAY_KEY_SECRET,
        isDevelopment: isDev,
      });
    }

    // Update order status
    await ordersCol.updateOne(
      { id: orderId },
      {
        $set: {
          status: "cancelled_by_customer",
          refund: {
            status: refundResult?.success ? "refunded" : "none",
            amount: order.totalAmount,
            type: "full",
            reason: "Customer cancelled before order window closed",
            razorpayRefundId: refundResult?.refundId,
            refundedAt: new Date(),
          },
          updatedAt: new Date(),
        },
        $push: {
          timeline: {
            status: "cancelled_by_customer",
            timestamp: new Date(),
            note: "Customer cancelled order before window closed. Full refund initiated.",
          },
        } as any,
      },
    );

    // Release dispatch slot reservation so it becomes available for other customers
    if (order.dispatchDate && order.dispatchSlot?.id) {
      await releaseSlotReservation(db, {
        dateStr: order.dispatchDate,
        slotId: order.dispatchSlot.id,
        orderId: order.id,
      });
    }

    const updated = await ordersCol.findOne({ id: orderId });

    // Send cancellation & refund email notice via Resend to customer and kitchen admin
    sendOrderStatusEmail({
      order: updated || order,
      status: "cancelled_by_customer",
      note: "Cancelled by customer before ordering window closed. Full refund initiated.",
      apiKey: c.env.RESEND_API_KEY,
      fromEmail: c.env.RESEND_FROM_EMAIL,
      adminEmail: c.env.ADMIN_NOTIFICATION_EMAIL,
      isDevelopment: isDev,
    }).catch((e) => console.error("Failed to send cancellation email:", e));

    // Broadcast SSE update to Admin Dashboard
    await recordOrderEvent(db, {
      type: "order_cancelled",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "cancelled_by_customer",
      summary: {
        reason: "Cancelled by customer before order window closed",
        refundAmount: order.totalAmount,
      },
    });

    return c.json({
      success: true,
      message: "Order cancelled successfully. Full refund has been initiated.",
      order: updated,
      refund: refundResult,
    });
  } catch (error) {
    console.error("Cancel customer order error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { clientOrderRoutes };
