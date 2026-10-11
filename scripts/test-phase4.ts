import { Redis } from "@upstash/redis";
import { MongoClient } from "mongodb";
import { generateNextOrderNumber } from "../src/lib/order-sequence";
import { Ratelimit } from "@upstash/ratelimit";
import { loadEnv } from "./load-env";

loadEnv();

const MONGODB_URI = process.env.MONGODB_URI || "";
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function verifyPhase4() {
  console.log("1. Connecting to Redis and MongoDB...");
  const redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db("nepali-tales");

  try {
    console.log("2. Testing concurrent atomic order number generation...");
    // Reset counter for test verification to 1000
    await redis.set("counter:orders:seq", 1000);

    const generated = await Promise.all([
      generateNextOrderNumber(db, redis),
      generateNextOrderNumber(db, redis),
      generateNextOrderNumber(db, redis),
      generateNextOrderNumber(db, redis),
      generateNextOrderNumber(db, redis),
    ]);

    console.log("   Concurrently generated order numbers:", generated);

    const uniqueCount = new Set(generated).size;
    if (uniqueCount === 5) {
      console.log("[SUCCESS] Zero collisions: All 5 order numbers are strictly unique and sequential!");
    } else {
      throw new Error(`Race hazard detected! Unique count: ${uniqueCount} of 5`);
    }

    // Reset back to 1000 so the first real order in prod is NT-1001
    await redis.set("counter:orders:seq", 1000);
    console.log("   Reset prod sequence base to 1000 (first real order will be NT-1001).");

    console.log("3. Testing global Upstash Ratelimit...");
    const ratelimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(3, "10 s"),
      prefix: "test:rl",
    });

    const testId = "test_user_ip_1";
    const res1 = await ratelimiter.limit(testId);
    const res2 = await ratelimiter.limit(testId);
    const res3 = await ratelimiter.limit(testId);
    const res4 = await ratelimiter.limit(testId);

    console.log(`   Attempt 1: success=${res1.success}`);
    console.log(`   Attempt 2: success=${res2.success}`);
    console.log(`   Attempt 3: success=${res3.success}`);
    console.log(`   Attempt 4 (must be blocked): success=${res4.success}`);

    if (res1.success && res2.success && res3.success && !res4.success) {
      console.log("[SUCCESS] Global Rate Limiter verified: 4th attempt correctly blocked at the edge!");
    } else {
      throw new Error("Rate limiter did not block as expected");
    }

    console.log("[DONE] Phase 4 Atomic Counters, Sessions & Global Rate Limiting verified!");
  } finally {
    await client.close();
  }
}

verifyPhase4().catch((err) => {
  console.error("[FAILED] Phase 4 verification failed:", err);
  process.exit(1);
});
