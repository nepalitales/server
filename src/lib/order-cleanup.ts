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
 * RACE PREVENTION ARCHITECTURE:
 * 1. Atomically transitions the order to "expired" via compare-and-swap FIRST.
 * 2. ONLY releases the dispatch slot reservation hold IF the atomic transition succeeded.
 *    If a concurrent payment completed at this exact millisecond, `findOneAndUpdate` returns
 *    null (because the status is now "placed"), guaranteeing that a paying customer's slot
 *    is NEVER released or overbooked.
 */
export async function cleanupExpiredPendingOrders(
  db: Db,
  maxAgeMinutes: number = 15,
): Promise<OrderCleanupResult> {
  const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
  const now = new Date();
  const cutoffTime = new Date(now.getTime() - maxAgeMinutes * 60 * 1000);

  // Find candidate pending_payment orders where slot hold expired or older than cutoff
  const candidateOrders = await ordersCol
    .find({
      status: "pending_payment",
      $or: [
        { slotHoldExpiresAt: { $lte: now } },
        { createdAt: { $lte: cutoffTime } },
      ],
    })
    .limit(100)
    .toArray();

  if (candidateOrders.length === 0) {
    return { expiredCount: 0, slotsReleased: 0, orderIds: [] };
  }

  let slotsReleased = 0;
  const processedOrderIds: string[] = [];

  for (const order of candidateOrders) {
    // 1. ATOMIC COMPARE-AND-SWAP FIRST:
    // Only transitions if the order is STILL in "pending_payment" status right now.
    const expiredDoc = await ordersCol.findOneAndUpdate(
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
            note: "Checkout session expired (unpaid after timeout). Reserved dispatch slot released.",
          },
        } as any,
      },
      { returnDocument: "after" },
    );

    // 2. RELEASE SLOT ONLY IF THIS CLEANUP RUNNER WON THE TRANSITION:
    // If payment confirmed concurrently, expiredDoc is null and the slot is PRESERVED.
    if (expiredDoc) {
      processedOrderIds.push(expiredDoc.id);

      if (expiredDoc.dispatchDate && expiredDoc.dispatchSlot?.id) {
        try {
          const released = await releaseSlotReservation(db, {
            dateStr: expiredDoc.dispatchDate,
            slotId: expiredDoc.dispatchSlot.id,
            orderId: expiredDoc.id,
          });
          if (released) slotsReleased++;
        } catch (err) {
          console.error(`[OrderCleanup]: Failed to release slot for order ${expiredDoc.id}:`, err);
        }
      }
    }
  }

  return {
    expiredCount: processedOrderIds.length,
    slotsReleased,
    orderIds: processedOrderIds,
  };
}
