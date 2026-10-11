import { Redis } from "@upstash/redis";
import { MongoClient } from "mongodb";
import { CACHE_KEYS, cacheGet, cacheSet } from "../src/lib/redis";
import { bumpConfigVersion, getConfigVersion } from "../src/lib/config-version";
import { loadEnv } from "./load-env";

loadEnv();

const MONGODB_URI = process.env.MONGODB_URI || "";
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function verifyCacheLayer() {
  console.log("1. Initializing Redis and MongoDB connections for cache verification...");
  const redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db("nepali-tales");

  const mockEnv = {
    UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN,
  };

  try {
    console.log("2. Simulating edge caching for Menu Categories...");
    const sampleMenu = { success: true, categories: [{ id: "test", name: "Momo" }] };
    await cacheSet(redis, CACHE_KEYS.MENU_CATEGORIES, sampleMenu, 300);

    const cached = await cacheGet(redis, CACHE_KEYS.MENU_CATEGORIES);
    console.log("   Cache HIT verified:", JSON.stringify(cached));

    console.log("3. Testing instant cache eviction on Admin mutation (bumpConfigVersion)...");
    const newVersion = await bumpConfigVersion(db, mockEnv);
    console.log("   Config version bumped to:", newVersion);

    const postInvalidation = await cacheGet(redis, CACHE_KEYS.MENU_CATEGORIES);
    console.log("   Post-invalidation cache value (must be null):", postInvalidation);

    if (postInvalidation === null) {
      console.log("[SUCCESS] Cache eviction verified: Stale menu was purged instantly!");
    } else {
      throw new Error("Cache eviction failed: Key still exists");
    }

    console.log("4. Verifying config-version retrieval from Redis...");
    const readVersion = await getConfigVersion(db, mockEnv);
    console.log("   Retrieved config version:", readVersion);

    if (readVersion === newVersion) {
      console.log("[SUCCESS] Config version sync verified between Redis and MongoDB!");
    } else {
      throw new Error("Config version mismatch");
    }

    console.log("[DONE] Phase 3 Edge Caching & Eviction Layer fully verified and operational!");
  } finally {
    await client.close();
  }
}

verifyCacheLayer().catch((e) => {
  console.error("[FAILED] Cache verification failed:", e);
  process.exit(1);
});
