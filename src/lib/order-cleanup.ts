import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import { releaseSlotReservation } from "./dispatch-windows";
import type { OrderDoc } from "../types";

export interface OrderCleanupResult {
  expiredCount: number;
  slotsReleased: number;
  orderIds: string[];
}

/**
 * Sweeps for abandoned "pending_payment" checkout orders older than 15 minutes
 * or whose slot reservation hold time has passed.
 *
 * 1. Releases the slot hold in `dispatch_slot_buckets` so the cooking window
 *    capacity is immediately restored for other paying customers.
 * 2. Marks the order as "expired" (payment failed / session timed out).
 */
export async function cleanupExpiredPendingOrders(
  db: Db,
  maxAgeMinutes: number = 15,
): Promise<OrderCleanupResult> {
  const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
  const now = new Date();
  const cutoffTime = new Date(now.getTime() - maxAgeMinutes * 60 * 1000);

  // Find pending_payment orders where slot hold expired or older than cutoff
  const expiredOrders = await ordersCol
    .find({
      status: "pending_payment",
      $or: [
        { slotHoldExpiresAt: { $lte: now } },
        { createdAt: { $lte: cutoffTime } },
      ],
    })
    .limit(100)
    .toArray();

  if (expiredOrders.length === 0) {
    return { expiredCount: 0, slotsReleased: 0, orderIds: [] };
  }

  let slotsReleased = 0;
  const processedOrderIds: string[] = [];

  for (const order of expiredOrders) {
    // 1. Release slot hold from dispatch_slot_buckets
    if (order.dispatchDate && order.dispatchSlot?.id) {
      try {
        const released = await releaseSlotReservation(db, {
          dateStr: order.dispatchDate,
          slotId: order.dispatchSlot.id,
          orderId: order.id,
        });
        if (released) slotsReleased++;
      } catch (err) {
        console.error(`[OrderCleanup]: Failed to release slot for order ${order.id}:`, err);
      }
    }

    // 2. Atomically transition from pending_payment to expired
    const res = await ordersCol.updateOne(
      { id: order.id, status: "pending_payment" },
      {
        $set: {
          status: "expired",
          "payment.status": "failed",
          updatedAt: now,
        },
        $push: {
          timeline: {
            status: "expired",
            timestamp: now,
            note: "Checkout session expired (unpaid after 15 minutes). Reserved dispatch slot released.",
          },
        } as any,
      },
    );

    if (res.modifiedCount > 0) {
      processedOrderIds.push(order.id);
    }
  }

  return {
    expiredCount: processedOrderIds.length,
    slotsReleased,
    orderIds: processedOrderIds,
  };
}
