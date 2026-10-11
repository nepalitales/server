import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { authMiddleware } from "../../middleware/auth";
import { dispatchBorzoPorter } from "../../lib/borzo-dispatch";
import { initiateRazorpayRefund } from "../../lib/razorpay";
import { recordOrderEvent, getOrderEventsSince } from "../../lib/order-events";
import { releaseSlotReservation } from "../../lib/dispatch-windows";
import { sendOrderStatusEmail } from "../../lib/email";
import { getIstDateTime } from "../../lib/order-window";
import {
  adminUpdateOrderStatusSchema,
  adminCancelOrderSchema,
  reportsQuerySchema,
} from "../../schemas";
import { formatZodErrors } from "../../utils";
import type { Db } from "mongodb";
import type { OrderDoc, OrderStatus } from "../../types";

const adminOrderRoutes = new Hono<AppBindings>();

// All admin order endpoints require admin authentication
adminOrderRoutes.use("*", authMiddleware);

/**
 * Automatically transitions all placed orders whose cancellation cutoff
 * (order window closing time) has passed into "preparing" status.
 */
export async function autoTransitionOrdersToPreparing(db: Db): Promise<number> {
  const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
  const now = new Date();

  const expiredPlacedOrders = await ordersCol
    .find({
      status: "placed",
      canCustomerCancelUntil: { $lte: now },
    })
    .toArray();

  if (expiredPlacedOrders.length === 0) return 0;

  for (const order of expiredPlacedOrders) {
    await ordersCol.updateOne(
      { id: order.id },
      {
        $set: {
          status: "preparing",
          updatedAt: now,
        },
        $push: {
          timeline: {
            status: "preparing",
            timestamp: now,
            note: "Order window closed. Order automatically moved to kitchen preparation.",
          },
        } as any,
      },
    );

    await recordOrderEvent(db, {
      type: "order_status_updated",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "preparing",
      summary: { autoTransition: true, reason: "Order window closed" },
    });
  }

  return expiredPlacedOrders.length;
}

// ─── 1. Real-Time Admin SSE Stream ────────────────────────────────


/**
 * GET /api/admin/orders/events
 *
 * Real-time Server-Sent Events stream for the Admin Dashboard orders screen.
 * Pushes live updates whenever orders are placed, cancelled, or status-changed.
 */
adminOrderRoutes.get("/events", async (c) => {
  const db = c.get("db");
  const client = c.get("dbClient");
  const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (event: string, data: Record<string, unknown>) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    return writer.write(encoder.encode(payload));
  };

  const streamPromise = (async () => {
    try {
      // 1. Initial counts snapshot
      const [placed, preparing, ready, porterBooked, delivered, cancelled] =
        await Promise.all([
          ordersCol.countDocuments({ status: "placed" }),
          ordersCol.countDocuments({ status: "preparing" }),
          ordersCol.countDocuments({ status: "ready" }),
          ordersCol.countDocuments({ status: { $in: ["porter_booked", "out_for_delivery"] } }),
          ordersCol.countDocuments({ status: "delivered" }),
          ordersCol.countDocuments({
            status: { $in: ["cancelled_by_customer", "cancelled_by_admin"] },
          }),
        ]);

      let lastCheckedMs = Date.now() - 5_000;

      await send("connected", {
        message: "Connected to real-time admin orders feed",
        counts: {
          placed,
          preparing,
          ready,
          porterBooked,
          delivered,
          cancelled,
        },
      });

      const pollIntervalMs = 3_000;
      const maxRunMs = 25_000;
      const startedAt = Date.now();

      while (Date.now() - startedAt < maxRunMs) {
        await new Promise<void>((r) => setTimeout(r, pollIntervalMs));

        const events = await getOrderEventsSince(db, lastCheckedMs);

        if (events.length > 0) {
          lastCheckedMs = Date.now();
          for (const ev of events) {
            await send(ev.type, {
              orderId: ev.orderId,
              orderNumber: ev.orderNumber,
              status: ev.status,
              summary: ev.summary,
              timestamp: ev.timestamp,
            });
          }
        } else {
          // Heartbeat to keep connection alive
          await send("heartbeat", { ts: Date.now() });
        }
      }

      await send("reconnect", { reason: "stream_timeout" });
    } catch {
      // Client disconnected
    } finally {
      await writer.close().catch(() => {});
      await client?.close().catch(() => {});
    }
  })();

  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(streamPromise);
  }

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// ─── 2. List Orders (With Filters & Pagination) ────────────────────

/**
 * GET /api/admin/orders
 *
 * Query params:
 * - status: "placed" | "preparing" | "ready" | etc.
 * - search: search by customer name, phone, or orderNumber
 * - page: page number (default 1)
 * - limit: items per page (default 25)
 */
adminOrderRoutes.get("/", async (c) => {
  try {
    const status = c.req.query("status");
    const search = c.req.query("search")?.trim();
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "25", 10)));
    const skip = (page - 1) * limit;

    const db = c.get("db");
    // Automatically transition any placed orders whose order window closed into "preparing"
    await autoTransitionOrdersToPreparing(db);

    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const filter: Record<string, unknown> = {};

    if (status) {
      filter.status = status;
    }

    if (search) {
      filter.$or = [
        { orderNumber: { $regex: search, $options: "i" } },
        { "customer.name": { $regex: search, $options: "i" } },
        { "customer.phone": { $regex: search.replace(/\D/g, "") } },
      ];
    }

    const [orders, total, placedCount, preparingCount, readyCount] = await Promise.all([
      ordersCol.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      ordersCol.countDocuments(filter),
      ordersCol.countDocuments({ status: "placed" }),
      ordersCol.countDocuments({ status: "preparing" }),
      ordersCol.countDocuments({ status: "ready" }),
    ]);

    return c.json({
      success: true,
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      counts: {
        placed: placedCount,
        preparing: preparingCount,
        ready: readyCount,
      },
    });
  } catch (error) {
    console.error("Admin list orders error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * POST /api/admin/orders/auto-prepare
 *
 * Explicit trigger (e.g. from cron or dashboard button) to transition all placed orders
 * whose cancellation cutoff has passed into "preparing" status.
 */
adminOrderRoutes.post("/auto-prepare", async (c) => {
  try {
    const db = c.get("db");
    const count = await autoTransitionOrdersToPreparing(db);
    return c.json({
      success: true,
      message: `Successfully transitioned ${count} order(s) to 'preparing'`,
      count,
    });
  } catch (error) {
    console.error("Auto-prepare orders error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 3. View Cancelled Orders (Auto & Manual Refunds) ─────────────

/**
 * GET /api/admin/orders/cancelled
 *
 * Displays all cancelled orders along with Razorpay refund progress.
 */
adminOrderRoutes.get("/cancelled", async (c) => {
  try {
    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const cancelledOrders = await ordersCol
      .find({
        status: { $in: ["cancelled_by_customer", "cancelled_by_admin"] },
      })
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray();

    const totalRefunded = cancelledOrders.reduce((sum, o) => {
      return sum + (o.refund?.amount || 0);
    }, 0);

    return c.json({
      success: true,
      cancelledOrders,
      count: cancelledOrders.length,
      totalRefundedAmount: totalRefunded,
    });
  } catch (error) {
    console.error("Admin cancelled orders error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 4. Monthly Reports (Revenue & Top Products) ───────────────────

/**
 * GET /api/admin/orders/reports
 *
 * Query params:
 *   ?period=this_week | this_month | last_month (defaults to this_month)
 *   ?month=YYYY-MM (legacy support for specific month)
 * Aggregates revenue, order volume, cancellation rates, daily timeline points, and top products.
 */
adminOrderRoutes.get("/reports", async (c) => {
  try {
    const monthQuery = c.req.query("month");
    const periodQuery = c.req.query("period") as
      | "this_week"
      | "this_month"
      | "last_month"
      | "this_year"
      | undefined;
    const parsed = reportsQuerySchema.safeParse({ month: monthQuery, period: periodQuery });

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid query parameters. Period must be 'this_week', 'this_month', or 'last_month'.",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const { dateStr } = getIstDateTime();
    const period = parsed.data.period || (parsed.data.month ? undefined : "this_month");
    const targetMonth = parsed.data.month || dateStr.slice(0, 7);

    let start: Date;
    let end: Date;
    let periodKey: string;
    let periodLabel: string;
    const daysList: Array<{ date: string; label: string }> = [];

    const MONTH_NAMES = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    if (period === "this_week") {
      periodKey = "this_week";
      const [curY, curM, curD] = dateStr.split("-").map(Number);
      const todayDate = new Date(Date.UTC(curY!, curM! - 1, curD!));
      const dayOfWeek = todayDate.getUTCDay(); // 0 is Sun, 1 is Mon...
      const diffToMonday = (dayOfWeek + 6) % 7;
      const mondayDate = new Date(todayDate);
      mondayDate.setUTCDate(todayDate.getUTCDate() - diffToMonday);

      for (let i = 0; i < 7; i++) {
        const d = new Date(mondayDate);
        d.setUTCDate(mondayDate.getUTCDate() + i);
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(d.getUTCDate()).padStart(2, "0");
        const ds = `${yyyy}-${mm}-${dd}`;
        daysList.push({
          date: ds,
          label: `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`,
        });
      }

      start = new Date(`${daysList[0]!.date}T00:00:00+05:30`);
      const nextMon = new Date(mondayDate);
      nextMon.setUTCDate(mondayDate.getUTCDate() + 7);
      const nextMonStr = `${nextMon.getUTCFullYear()}-${String(nextMon.getUTCMonth() + 1).padStart(2, "0")}-${String(nextMon.getUTCDate()).padStart(2, "0")}`;
      end = new Date(`${nextMonStr}T00:00:00+05:30`);

      const startLabel = daysList[0]!.label.split(", ")[1];
      const endLabel = daysList[6]!.label.split(", ")[1];
      periodLabel = `This Week (${startLabel} – ${endLabel})`;
    } else if (period === "last_month") {
      periodKey = "last_month";
      const curMonthNum = parseInt(dateStr.slice(5, 7), 10);
      const curYearNum = parseInt(dateStr.slice(0, 4), 10);
      const prevYear = curMonthNum === 1 ? curYearNum - 1 : curYearNum;
      const prevMonth = curMonthNum === 1 ? 12 : curMonthNum - 1;
      const prevMonthStr = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

      start = new Date(`${prevMonthStr}-01T00:00:00+05:30`);
      end = new Date(`${curYearNum}-${String(curMonthNum).padStart(2, "0")}-01T00:00:00+05:30`);

      const daysInPrevMonth = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
      for (let i = 1; i <= daysInPrevMonth; i++) {
        const ds = `${prevMonthStr}-${String(i).padStart(2, "0")}`;
        daysList.push({
          date: ds,
          label: `${i} ${MONTH_NAMES[prevMonth - 1]}`,
        });
      }

      const fullMonthName = new Date(`${prevMonthStr}-01T12:00:00+05:30`).toLocaleDateString("en-IN", {
        month: "long",
        year: "numeric",
      });
      periodLabel = `Last Month (${fullMonthName})`;
    } else if (period === "this_year") {
      periodKey = "this_year";
      const curYearNum = parseInt(dateStr.slice(0, 4), 10);
      start = new Date(`${curYearNum}-01-01T00:00:00+05:30`);
      end = new Date(`${curYearNum + 1}-01-01T00:00:00+05:30`);

      for (let m = 1; m <= 12; m++) {
        const monthStr = `${curYearNum}-${String(m).padStart(2, "0")}`;
        daysList.push({
          date: monthStr,
          label: `${MONTH_NAMES[m - 1]} ${curYearNum}`,
        });
      }

      periodLabel = `This Year (${curYearNum})`;
    } else {
      periodKey = period === "this_month" ? "this_month" : "custom_month";
      const monthToUse = targetMonth;
      const curMonthNum = parseInt(monthToUse.slice(5, 7), 10);
      const curYearNum = parseInt(monthToUse.slice(0, 4), 10);
      const nextYear = curMonthNum === 12 ? curYearNum + 1 : curYearNum;
      const nextMonth = curMonthNum === 12 ? 1 : curMonthNum + 1;
      const nextMonthStr = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;

      start = new Date(`${monthToUse}-01T00:00:00+05:30`);
      end = new Date(`${nextMonthStr}-01T00:00:00+05:30`);

      const daysInMonth = new Date(Date.UTC(curYearNum, curMonthNum, 0)).getUTCDate();
      for (let i = 1; i <= daysInMonth; i++) {
        const ds = `${monthToUse}-${String(i).padStart(2, "0")}`;
        daysList.push({
          date: ds,
          label: `${i} ${MONTH_NAMES[curMonthNum - 1]}`,
        });
      }

      const fullMonthName = new Date(`${monthToUse}-01T12:00:00+05:30`).toLocaleDateString("en-IN", {
        month: "long",
        year: "numeric",
      });
      periodLabel = period === "this_month" ? `This Month (${fullMonthName})` : fullMonthName;
    }

    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const dateMatch = {
      createdAt: { $gte: start, $lt: end },
    };

    const timelineFormat = period === "this_year" ? "%Y-%m" : "%Y-%m-%d";

    const [
      revenueAgg,
      topProductsAgg,
      totalOrdersCount,
      cancelledOrdersCount,
      timelineRevenueAgg,
      timelineCancelledAgg,
    ] = await Promise.all([
      // Revenue sum for non-cancelled orders
      ordersCol
        .aggregate([
          {
            $match: {
              ...dateMatch,
              status: {
                $nin: [
                  "cancelled_by_customer",
                  "cancelled_by_admin",
                  "pending_payment",
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: "$totalAmount" },
              avgOrderValue: { $avg: "$totalAmount" },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),

      // Top products sold
      ordersCol
        .aggregate([
          {
            $match: {
              ...dateMatch,
              status: {
                $nin: [
                  "cancelled_by_customer",
                  "cancelled_by_admin",
                  "pending_payment",
                ],
              },
            },
          },
          { $unwind: "$items" },
          {
            $group: {
              _id: "$items.productId",
              productName: { $first: "$items.productName" },
              quantitySold: { $sum: "$items.quantity" },
              revenueGenerated: { $sum: "$items.subtotal" },
            },
          },
          { $sort: { quantitySold: -1 } },
          { $limit: 10 },
        ])
        .toArray(),

      ordersCol.countDocuments(dateMatch),
      ordersCol.countDocuments({
        ...dateMatch,
        status: { $in: ["cancelled_by_customer", "cancelled_by_admin"] },
      }),

      // Daily or monthly revenue & paid orders in IST
      ordersCol
        .aggregate([
          {
            $match: {
              ...dateMatch,
              status: {
                $nin: [
                  "cancelled_by_customer",
                  "cancelled_by_admin",
                  "pending_payment",
                ],
              },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: timelineFormat,
                  date: "$createdAt",
                  timezone: "Asia/Kolkata",
                },
              },
              revenue: { $sum: "$totalAmount" },
              orders: { $sum: 1 },
            },
          },
        ])
        .toArray(),

      // Daily or monthly cancelled orders in IST
      ordersCol
        .aggregate([
          {
            $match: {
              ...dateMatch,
              status: { $in: ["cancelled_by_customer", "cancelled_by_admin"] },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: timelineFormat,
                  date: "$createdAt",
                  timezone: "Asia/Kolkata",
                },
              },
              cancelledOrders: { $sum: 1 },
            },
          },
        ])
        .toArray(),
    ]);

    const stats = revenueAgg[0] || { totalRevenue: 0, avgOrderValue: 0, count: 0 };
    const revMap = new Map(timelineRevenueAgg.map((r: any) => [r._id, r]));
    const canMap = new Map(timelineCancelledAgg.map((c: any) => [c._id, c]));

    const timeline = daysList.map((d) => {
      const r = revMap.get(d.date) as any;
      const can = canMap.get(d.date) as any;
      return {
        date: d.date,
        label: d.label,
        revenue: r ? Math.round(r.revenue) : 0,
        orders: r ? r.orders : 0,
        cancelledOrders: can ? can.cancelledOrders : 0,
      };
    });

    return c.json({
      success: true,
      period: periodKey,
      periodLabel,
      dateRange: {
        start: daysList[0]?.date || "",
        end: daysList[daysList.length - 1]?.date || "",
      },
      month: targetMonth,
      summary: {
        totalRevenue: Math.round(stats.totalRevenue),
        avgOrderValue: Math.round(stats.avgOrderValue),
        paidOrdersCount: stats.count,
        totalOrdersCount,
        cancelledOrdersCount,
      },
      timeline,
      topProducts: topProductsAgg.map((p) => ({
        productId: p._id,
        productName: p.productName,
        quantitySold: p.quantitySold,
        revenueGenerated: Math.round(p.revenueGenerated),
      })),
    });
  } catch (error) {
    console.error("Admin reports error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 5. Get Single Order ──────────────────────────────────────────

/**
 * GET /api/admin/orders/:orderId
 *
 * Full order details for the dashboard modal.
 */
adminOrderRoutes.get("/:orderId", async (c) => {
  try {
    const orderId = c.req.param("orderId");
    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const order = await ordersCol.findOne({ id: orderId });
    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    return c.json({ success: true, order });
  } catch (error) {
    console.error("Admin get order error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 6. Print Bill / Receipt Data ─────────────────────────────────

/**
 * GET /api/admin/orders/:orderId/bill
 *
 * Formatted invoice / receipt payload suitable for kitchen thermal printer.
 */
adminOrderRoutes.get("/:orderId/bill", async (c) => {
  try {
    const orderId = c.req.param("orderId");
    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const order = await ordersCol.findOne({ id: orderId });
    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    const bill = {
      restaurant: {
        name: "Nepali Tales",
        tagline: "Authentic Nepali Momo & Artisanal Chilli Oil",
        address: c.env.KITCHEN_ADDRESS,
        phone: c.env.KITCHEN_PHONE,
      },
      order: {
        orderNumber: order.orderNumber,
        orderId: order.id,
        date: order.createdAt,
        status: order.status,
        orderType: order.orderType || "delivery",
      },
      customer: {
        name: order.customer.name,
        phone: order.customer.phone,
        email: order.customer.email,
        deliveryAddress: order.deliveryAddress.borzoFormat.address,
        note: order.deliveryAddress.borzoFormat.note,
      },
      items: order.items.map((i) => ({
        name: i.productName,
        price: i.price,
        quantity: i.quantity,
        total: i.subtotal,
      })),
      totals: {
        subtotal: order.itemTotal,
        deliveryFee: order.deliveryFee,
        discount: order.discount,
        grandTotal: order.totalAmount,
      },
      payment: {
        mode: order.payment.provider.toUpperCase(),
        status: order.payment.status.toUpperCase(),
        transactionId: order.payment.razorpayPaymentId || "N/A",
      },
    };

    return c.json({ success: true, bill });
  } catch (error) {
    console.error("Admin print bill error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 7. Update Status (Marking "ready" triggers Auto-Porter!) ──────

/**
 * PATCH /api/admin/orders/:orderId/status
 *
 * Updates order workflow status.
 * CRITICAL FLOW: When admin sets status to "ready", it AUTOMATICALLY
 * triggers Borzo Porter courier booking from Cloud Kitchen to Customer!
 */
adminOrderRoutes.patch("/:orderId/status", async (c) => {
  try {
    const orderId = c.req.param("orderId");
    const body = await c.req.json();
    const parsed = adminUpdateOrderStatusSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid status update data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const targetStatus = parsed.data.status;
    const note = parsed.data.note;
    const db = c.get("db");
    const isDev = c.env.NODE_ENV === "development";

    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const order = await ordersCol.findOne({ id: orderId });

    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    const now = new Date();

    const orderType = order.orderType || "delivery";

    if (targetStatus === "out_for_delivery" && orderType === "pickup") {
      return c.json(
        { success: false, message: "Pickup orders cannot be marked out for delivery" },
        400,
      );
    }

    // Pickup: food is ready for the customer to collect - no Borzo booking
    if (targetStatus === "ready" && orderType === "pickup") {
      await ordersCol.updateOne(
        { id: orderId },
        {
          $set: { status: "ready", updatedAt: now },
          $push: {
            timeline: {
              status: "ready",
              timestamp: now,
              note: note || "Order is ready for pickup at the kitchen",
            },
          } as any,
        },
      );

      const updated = await ordersCol.findOne({ id: orderId });
      if (order.customer?.email) {
        sendOrderStatusEmail({
          order: updated || order,
          status: "ready",
          note: note || "Your order is ready for pickup.",
          apiKey: c.env.RESEND_API_KEY,
          fromEmail: c.env.RESEND_FROM_EMAIL,
          isDevelopment: isDev,
        }).catch((e) => console.error("Failed to send pickup-ready email:", e));
      }

      await recordOrderEvent(db, {
        type: "order_status_updated",
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: "ready",
        summary: { orderType: "pickup" },
      });

      return c.json({
        success: true,
        message: "Order marked ready for pickup. Customer has been emailed.",
        order: updated,
      });
    }

    // ── AUTOMATED PORTER DISPATCH ON "ready" (delivery only) ──────
    if (targetStatus === "ready") {
      const porterResult = await dispatchBorzoPorter({
        order,
        kitchenAddress: c.env.KITCHEN_ADDRESS,
        kitchenPhone: c.env.KITCHEN_PHONE,
        borzoServiceUrl: c.env.BORZO_SERVICE_URL,
        borzoServiceKey: c.env.BORZO_SERVICE_KEY,
        isDevelopment: isDev,
      });

      if (!porterResult.success) {
        // Porter dispatch failed -- record failure so admin can retry or call customer
        await ordersCol.updateOne(
          { id: orderId },
          {
            $set: {
              status: "porter_failed",
              borzo: {
                error: porterResult.error,
                updatedAt: now,
              },
              updatedAt: now,
            },
            $push: {
              timeline: {
                status: "porter_failed",
                timestamp: now,
                note: `Marked ready, but automated porter booking failed: ${porterResult.error}`,
              },
            } as any,
          },
        );

        await recordOrderEvent(db, {
          type: "porter_status_updated",
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: "porter_failed",
          summary: { error: porterResult.error },
        });

        return c.json(
          {
            success: false,
            porterFailed: true,
            message:
              "Food is marked ready, but automated Borzo Porter booking failed. Please click 'Retry Porter' or call customer.",
            error: porterResult.error,
            hint: porterResult.hint,
          },
          422,
        );
      }

      // Porter booking succeeded!
      await ordersCol.updateOne(
        { id: orderId },
        {
          $set: {
            status: "porter_booked",
            borzo: porterResult.borzoInfo,
            updatedAt: now,
          },
          $push: {
            timeline: {
              status: "porter_booked",
              timestamp: now,
              note: `Food ready. Borzo Porter booked (ID: ${porterResult.borzoInfo?.borzoOrderName}). Live tracking: ${porterResult.borzoInfo?.trackingUrl}`,
            },
          } as any,
        },
      );

      const updated = await ordersCol.findOne({ id: orderId });

      // Send live tracking email to customer via Resend
      if (order.customer?.email) {
        sendOrderStatusEmail({
          order,
          status: "porter_booked",
          trackingUrl: porterResult.borzoInfo?.trackingUrl,
          apiKey: c.env.RESEND_API_KEY,
          fromEmail: c.env.RESEND_FROM_EMAIL,
          isDevelopment: isDev,
        }).catch((e) => console.error("Failed to send porter booked email:", e));
      }

      await recordOrderEvent(db, {
        type: "order_status_updated",
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: "porter_booked",
        summary: {
          borzoOrderId: porterResult.borzoInfo?.borzoOrderId,
          trackingUrl: porterResult.borzoInfo?.trackingUrl,
        },
      });

      return c.json({
        success: true,
        message: "Food marked ready and Borzo Porter successfully booked!",
        order: updated,
        borzo: porterResult.borzoInfo,
      });
    }

    // Standard status update (preparing, out_for_delivery, delivered)
    await ordersCol.updateOne(
      { id: orderId },
      {
        $set: {
          status: targetStatus,
          updatedAt: now,
        },
        $push: {
          timeline: {
            status: targetStatus,
            timestamp: now,
            note: note || `Status changed to ${targetStatus}`,
          },
        } as any,
      },
    );

    const updated = await ordersCol.findOne({ id: orderId });

    // Send order status update email to customer via Resend
    if (order.customer?.email) {
      sendOrderStatusEmail({
        order,
        status: targetStatus,
        trackingUrl: order.borzo?.trackingUrl,
        note,
        apiKey: c.env.RESEND_API_KEY,
        fromEmail: c.env.RESEND_FROM_EMAIL,
        isDevelopment: isDev,
      }).catch((e) => console.error("Failed to send status update email:", e));
    }

    await recordOrderEvent(db, {
      type: "order_status_updated",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: targetStatus,
    });

    return c.json({
      success: true,
      message: `Order status updated to '${targetStatus}'`,
      order: updated,
    });
  } catch (error) {
    console.error("Admin update status error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 8. Retry Porter Booking ───────────────────────────────────────

/**
 * POST /api/admin/orders/:orderId/retry-porter
 *
 * Retries dispatching the automated Borzo porter booking if the initial attempt failed.
 */
adminOrderRoutes.post("/:orderId/retry-porter", async (c) => {
  try {
    const orderId = c.req.param("orderId");
    const db = c.get("db");
    const isDev = c.env.NODE_ENV === "development";

    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const order = await ordersCol.findOne({ id: orderId });

    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    if ((order.orderType || "delivery") === "pickup") {
      return c.json(
        { success: false, message: "Pickup orders do not use porter dispatch" },
        400,
      );
    }

    const porterResult = await dispatchBorzoPorter({
      order,
      kitchenAddress: c.env.KITCHEN_ADDRESS,
      kitchenPhone: c.env.KITCHEN_PHONE,
      borzoServiceUrl: c.env.BORZO_SERVICE_URL,
      borzoServiceKey: c.env.BORZO_SERVICE_KEY,
      isDevelopment: isDev,
    });

    const now = new Date();

    if (!porterResult.success) {
      return c.json(
        {
          success: false,
          message: `Retry porter booking failed: ${porterResult.error}`,
          hint: porterResult.hint,
        },
        422,
      );
    }

    await ordersCol.updateOne(
      { id: orderId },
      {
        $set: {
          status: "porter_booked",
          borzo: porterResult.borzoInfo,
          updatedAt: now,
        },
        $push: {
          timeline: {
            status: "porter_booked",
            timestamp: now,
            note: `Porter booking retried and succeeded (ID: ${porterResult.borzoInfo?.borzoOrderName}).`,
          },
        } as any,
      },
    );

    const updated = await ordersCol.findOne({ id: orderId });

    await recordOrderEvent(db, {
      type: "order_status_updated",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "porter_booked",
      summary: { trackingUrl: porterResult.borzoInfo?.trackingUrl },
    });

    return c.json({
      success: true,
      message: "Borzo Porter booking succeeded on retry!",
      order: updated,
      borzo: porterResult.borzoInfo,
    });
  } catch (error) {
    console.error("Retry porter booking error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 9. Admin Cancel Order (With Manual Refund Note) ───────────────

/**
 * POST /api/admin/orders/:orderId/cancel
 *
 * Admin cancels any confirmed order.
 * Requires cancellation reason and manual refund selection (full, partial, or decline).
 */
adminOrderRoutes.post("/:orderId/cancel", async (c) => {
  try {
    const orderId = c.req.param("orderId");
    const body = await c.req.json();
    const parsed = adminCancelOrderSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid cancellation data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const { reason, refundType, refundAmount, notes } = parsed.data;
    const db = c.get("db");
    const isDev = c.env.NODE_ENV === "development";

    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const order = await ordersCol.findOne({ id: orderId });

    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    let refundResult = null;
    const effectiveRefundAmount =
      refundType === "full"
        ? order.totalAmount
        : refundType === "partial"
          ? refundAmount!
          : 0;

    // Process Razorpay refund if requested
    if (
      refundType !== "decline" &&
      order.payment.status === "paid" &&
      order.payment.razorpayPaymentId
    ) {
      refundResult = await initiateRazorpayRefund({
        paymentId: order.payment.razorpayPaymentId,
        amountInInr: effectiveRefundAmount,
        reason,
        keyId: c.env.RAZORPAY_KEY_ID,
        keySecret: c.env.RAZORPAY_KEY_SECRET,
        isDevelopment: isDev,
      });
    }

    const now = new Date();
    await ordersCol.updateOne(
      { id: orderId },
      {
        $set: {
          status: "cancelled_by_admin",
          refund: {
            status: refundType === "decline" ? "declined" : "refunded",
            amount: effectiveRefundAmount,
            type: refundType,
            reason,
            razorpayRefundId: refundResult?.refundId,
            refundedAt: refundType === "decline" ? undefined : now,
            notes,
          },
          updatedAt: now,
        },
        $push: {
          timeline: {
            status: "cancelled_by_admin",
            timestamp: now,
            note: `Admin cancelled order. Reason: ${reason}. Refund: ${refundType} (₹${effectiveRefundAmount})`,
          },
        } as any,
      },
    );

    // Release dispatch slot reservation so it becomes available again
    if (order.dispatchDate && order.dispatchSlot?.id) {
      await releaseSlotReservation(db, {
        dateStr: order.dispatchDate,
        slotId: order.dispatchSlot.id,
        orderId: order.id,
      });
    }

    const updated = await ordersCol.findOne({ id: orderId });

    // Send cancellation notice to customer via Resend
    if (order.customer?.email) {
      sendOrderStatusEmail({
        order,
        status: "cancelled_by_admin",
        note: `Order cancelled by kitchen. Reason: ${reason}. Refund: ₹${effectiveRefundAmount}`,
        apiKey: c.env.RESEND_API_KEY,
        fromEmail: c.env.RESEND_FROM_EMAIL,
        isDevelopment: isDev,
      }).catch((e) => console.error("Failed to send admin cancellation email:", e));
    }

    await recordOrderEvent(db, {
      type: "order_cancelled",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "cancelled_by_admin",
      summary: {
        reason,
        refundType,
        refundAmount: effectiveRefundAmount,
      },
    });

    return c.json({
      success: true,
      message: `Order cancelled by admin. Refund decision: ${refundType}`,
      order: updated,
      refund: refundResult,
    });
  } catch (error) {
    console.error("Admin cancel order error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { adminOrderRoutes };
