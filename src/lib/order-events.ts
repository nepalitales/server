import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import { broadcastPushToAdmins } from "./web-push";

export interface OrderEventDoc {
  type: "order_created" | "order_status_updated" | "order_cancelled" | "porter_status_updated";
  orderId: string;
  orderNumber: string;
  status: string;
  timestamp: Date;
  summary?: Record<string, unknown>;
}

/**
 * Records an order event in MongoDB so the Admin SSE stream can broadcast it in real time,
 * and delivers background Web Push notifications to registered admin devices.
 */
export async function recordOrderEvent(
  db: Db,
  event: Omit<OrderEventDoc, "timestamp">,
  env?: {
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    VAPID_SUBJECT?: string;
  },
): Promise<void> {
  try {
    const events = db.collection<OrderEventDoc>(COLLECTIONS.ORDER_EVENTS);
    await events.insertOne({
      ...event,
      timestamp: new Date(),
    });

    // When an order is created, trigger background push notifications to all admin devices
    if (event.type === "order_created") {
      const totalText = event.summary?.totalAmount != null ? `₹${event.summary.totalAmount}` : "";
      const custText = event.summary?.customerName ? ` • ${event.summary.customerName}` : "";
      const itemsCount = event.summary?.itemsCount ? ` (${event.summary.itemsCount} items)` : "";
      const body = `${totalText}${itemsCount}${custText}`.trim() || "Tap to view order in kitchen queue";

      void broadcastPushToAdmins(db, env, {
        title: `🔔 New Order #${event.orderNumber} Received!`,
        body,
        orderId: event.orderId,
        orderNumber: event.orderNumber,
        url: "/orders",
        tag: `order-${event.orderNumber}`,
        timestamp: Date.now(),
      }).catch((err) => {
        console.error("[WebPush]: Failed to broadcast order_created push:", err);
      });
    }
  } catch (error) {
    console.error("Failed to record order event:", error);
  }
}

/**
 * Retrieves order events that occurred after a given timestamp (in ms).
 */
export async function getOrderEventsSince(
  db: Db,
  sinceMs: number,
): Promise<OrderEventDoc[]> {
  try {
    const events = db.collection<OrderEventDoc>(COLLECTIONS.ORDER_EVENTS);
    return await events
      .find({ timestamp: { $gt: new Date(sinceMs) } })
      .sort({ timestamp: 1 })
      .limit(50)
      .toArray();
  } catch (error) {
    console.error("Failed to query order events:", error);
    return [];
  }
}
