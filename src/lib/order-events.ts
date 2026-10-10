import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";

export interface OrderEventDoc {
  type: "order_created" | "order_status_updated" | "order_cancelled" | "porter_status_updated";
  orderId: string;
  orderNumber: string;
  status: string;
  timestamp: Date;
  summary?: Record<string, unknown>;
}

/**
 * Records an order event in MongoDB so the Admin SSE stream can broadcast it in real time.
 */
export async function recordOrderEvent(
  db: Db,
  event: Omit<OrderEventDoc, "timestamp">,
): Promise<void> {
  try {
    const events = db.collection<OrderEventDoc>(COLLECTIONS.ORDER_EVENTS);
    await events.insertOne({
      ...event,
      timestamp: new Date(),
    });
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
