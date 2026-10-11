import { Redis } from "@upstash/redis";
import { loadEnv } from "./load-env";

loadEnv();

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function testUpstashConnection() {
  console.log("Connecting to Upstash Redis at:", UPSTASH_REDIS_REST_URL);
  const redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });

  const testKey = "test:connection_check";
  const testVal = {
    app: "nepali-tales-prod",
    timestamp: new Date().toISOString(),
    status: "healthy",
  };

  console.log("Setting test key...");
  await redis.set(testKey, JSON.stringify(testVal), { ex: 60 });

  console.log("Reading test key back...");
  const raw = await redis.get(testKey);
  console.log("Retrieved data from Upstash Redis:", raw);

  console.log("Testing ping...");
  const pong = await redis.ping();
  console.log("Ping response:", pong);

  console.log("Cleaning up test key...");
  await redis.del(testKey);

  console.log("[DONE] Upstash Redis connection test PASSED with 0 errors!");
}

testUpstashConnection().catch((err) => {
  console.error("[FAILED] Upstash Redis connection test FAILED:", err);
  process.exit(1);
});
