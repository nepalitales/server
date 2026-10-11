import type { Db } from "mongodb";
import type { Redis } from "@upstash/redis";
import { COLLECTIONS } from "./db";
import { CACHE_KEYS } from "./redis";

const DEFAULT_BASE_SEQUENCE = 1000;

/**
 * Parses the numeric portion of an order number (e.g. "NT-1045" -> 1045).
 */
function parseOrderSeq(orderNumber?: string): number {
  if (!orderNumber) return DEFAULT_BASE_SEQUENCE;
  const match = orderNumber.match(/NT-(\d+)/i);
  return match && match[1] ? parseInt(match[1], 10) : DEFAULT_BASE_SEQUENCE;
}

/**
 * Finds the highest existing order sequence number in MongoDB.
 */
async function getHighestOrderNumberFromDb(db: Db): Promise<number> {
  const orders = db.collection(COLLECTIONS.ORDERS);
  const highestOrder = await orders
    .find({}, { projection: { orderNumber: 1 } })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  if (highestOrder.length === 0 || !highestOrder[0]?.orderNumber) {
    return DEFAULT_BASE_SEQUENCE;
  }

  return parseOrderSeq(highestOrder[0].orderNumber);
}

/**
 * Atomically generates the next unique, strictly sequential order number.
 * Uses Upstash Redis INCR for sub-millisecond atomic reservation.
 * Gracefully falls back to MongoDB atomic counter collection if Redis is unavailable.
 *
 * Prevents race conditions and duplicate key collisions during concurrent checkouts.
 */
export async function generateNextOrderNumber(
  db: Db,
  redis: Redis | null,
): Promise<string> {
  // 1. Try atomic Redis INCR
  if (redis) {
    try {
      const current = await redis.get<number>(CACHE_KEYS.COUNTER_ORDERS);
      if (!current || current < DEFAULT_BASE_SEQUENCE) {
        const highestDb = await getHighestOrderNumberFromDb(db);
        const base = Math.max(DEFAULT_BASE_SEQUENCE, highestDb);
        // Set base if not set
        await redis.setnx(CACHE_KEYS.COUNTER_ORDERS, base);
      }

      const nextNum = await redis.incr(CACHE_KEYS.COUNTER_ORDERS);
      return `NT-${nextNum}`;
    } catch (err) {
      console.warn("[Order Sequence] Redis atomic incr failed, falling back to MongoDB:", err);
    }
  }

  // 2. Fallback: MongoDB atomic findOneAndUpdate counter
  const counters = db.collection<{ _id: string; seq: number }>("counters");
  const existingCounter = await counters.findOne({ _id: "order_number" });

  if (!existingCounter || existingCounter.seq < DEFAULT_BASE_SEQUENCE) {
    const highestDb = await getHighestOrderNumberFromDb(db);
    const base = Math.max(DEFAULT_BASE_SEQUENCE, highestDb);
    await counters.updateOne(
      { _id: "order_number" },
      { $setOnInsert: { seq: base } },
      { upsert: true },
    );
  }

  const result = await counters.findOneAndUpdate(
    { _id: "order_number" },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true },
  );

  const seq = result?.seq ?? 1001;
  return `NT-${seq}`;
}
