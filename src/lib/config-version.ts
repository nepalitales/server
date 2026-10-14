import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import { getRedisClient, cacheGet, cacheSet, cacheDel, CACHE_KEYS } from "./redis";
import { invalidateLocalMemoryCache } from "../middleware/edge-cache";

const CONFIG_VERSION_DOC_ID = "global";

let memoryCachedVersion: { version: string; expiresAt: number } | null = null;

export function invalidateConfigVersionCache() {
  memoryCachedVersion = null;
}

export function getCachedConfigVersion(): string | null {
  if (memoryCachedVersion && memoryCachedVersion.expiresAt > Date.now()) {
    return memoryCachedVersion.version;
  }
  return null;
}

export function setCachedConfigVersion(version: string) {
  memoryCachedVersion = {
    version,
    expiresAt: Date.now() + 15_000, // 15s isolate TTL
  };
}

/**
 * Bumps the config version in MongoDB and Redis.
 * Called by every admin mutation that clients care about.
 * Automatically evicts public client caches in Upstash Redis and isolate RAM.
 */
export async function bumpConfigVersion(db: Db, env?: any): Promise<string> {
  invalidateConfigVersionCache();
  invalidateLocalMemoryCache();

  const collection = db.collection<{
    _id?: unknown;
    docId: string;
    version: string;
    updatedAt: Date;
  }>(COLLECTIONS.CONFIG_VERSION);

  const version = Date.now().toString();

  await collection.updateOne(
    { docId: CONFIG_VERSION_DOC_ID },
    {
      $set: {
        docId: CONFIG_VERSION_DOC_ID,
        version,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  setCachedConfigVersion(version);

  // Invalidate Redis caches
  const redis = getRedisClient(env);
  if (redis) {
    try {
      await cacheSet(redis, CACHE_KEYS.CONFIG_VERSION, version, 86400);
      await cacheDel(
        redis,
        CACHE_KEYS.MENU_CATEGORIES,
        CACHE_KEYS.ORDER_WINDOWS,
        CACHE_KEYS.ORDER_WINDOW_STATUS,
        CACHE_KEYS.ORDER_SETTINGS,
        CACHE_KEYS.WEEKLY_OFF,
        CACHE_KEYS.HOLIDAYS,
        CACHE_KEYS.ADDONS,
        CACHE_KEYS.ADMIN_LIVE_SUMMARY,
        "cache:client:config_snapshot",
      );
    } catch (e) {
      console.warn("[Redis Cache Invalidation Warning]:", e);
    }
  }

  return version;
}

/**
 * Returns the current config version string.
 * Checks memory -> Redis -> MongoDB.
 */
export async function getConfigVersion(db: Db, env?: any): Promise<string> {
  const memoryCached = getCachedConfigVersion();
  if (memoryCached) return memoryCached;

  const redis = getRedisClient(env);
  if (redis) {
    try {
      const redisVersion = await cacheGet<string>(redis, CACHE_KEYS.CONFIG_VERSION);
      if (redisVersion) {
        setCachedConfigVersion(redisVersion);
        return redisVersion;
      }
    } catch {
      // Fallback to MongoDB
    }
  }

  const collection = db.collection<{
    docId: string;
    version: string;
  }>(COLLECTIONS.CONFIG_VERSION);

  const doc = await collection.findOne({ docId: CONFIG_VERSION_DOC_ID });
  const version = doc?.version ?? "0";
  setCachedConfigVersion(version);

  if (redis) {
    cacheSet(redis, CACHE_KEYS.CONFIG_VERSION, version, 86400).catch(() => {});
  }

  return version;
}

