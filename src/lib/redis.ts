import { Redis } from "@upstash/redis";
import type { Env } from "../config/env";

/**
 * Standard Cache Keys across the Nepali Tales edge platform.
 */
export const CACHE_KEYS = {
  // Public Client Caches
  MENU_CATEGORIES: "cache:client:categories_with_products",
  ORDER_WINDOWS: "cache:client:order_windows",
  ORDER_WINDOW_STATUS: "cache:client:order_window_status",
  ORDER_SETTINGS: "cache:client:order_settings",
  WEEKLY_OFF: "cache:client:weekly_off",
  HOLIDAYS: "cache:client:holidays",
  FAQS: "cache:client:faqs",
  ADDONS: "cache:client:addons",
  CONFIG_VERSION: "cache:client:config_version",

  // Admin Dashboard Polling Cache
  ADMIN_LIVE_SUMMARY: "cache:admin:live_summary",

  // Session & User Prefixes
  CLIENT_SESSION_PREFIX: "cache:session:client:",
  CLIENT_USER_PREFIX: "cache:user:client:",

  // Atomic Counters
  COUNTER_ORDERS: "counter:orders:seq",
} as const;

// Module-level singleton instance per isolate
let cachedClient: Redis | null = null;
let lastUrl: string | undefined;
let lastToken: string | undefined;

/**
 * Retrieves the Upstash Redis client for the current Worker isolate.
 * Returns null if credentials are not configured.
 */
export function getRedisClient(env?: Partial<Env>): Redis | null {
  const url =
    env?.UPSTASH_REDIS_REST_URL ||
    (typeof process !== "undefined" ? process.env?.UPSTASH_REDIS_REST_URL : undefined);
  const token =
    env?.UPSTASH_REDIS_REST_TOKEN ||
    (typeof process !== "undefined" ? process.env?.UPSTASH_REDIS_REST_TOKEN : undefined);

  if (!url || !token) {
    return null;
  }

  if (!cachedClient || url !== lastUrl || token !== lastToken) {
    cachedClient = new Redis({
      url,
      token,
      // Automatic retry once on transient network failure
      retry: {
        retries: 1,
        backoff: (retryCount) => Math.exp(retryCount) * 50,
      },
    });
    lastUrl = url;
    lastToken = token;
  }

  return cachedClient;
}

/**
 * Safely fetches a value from Redis cache.
 * If Redis is down, unreachable, or times out, returns null without throwing.
 */
export async function cacheGet<T>(
  redis: Redis | null,
  key: string,
): Promise<T | null> {
  if (!redis || !key) return null;
  try {
    const data = await redis.get<T>(key);
    return data ?? null;
  } catch (err) {
    console.warn(`[Redis Cache GET Error] Key: ${key}:`, err);
    return null;
  }
}

/**
 * Safely sets a value in Redis cache with an optional TTL in seconds.
 * Never throws exceptions if Redis fails.
 */
export async function cacheSet(
  redis: Redis | null,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  if (!redis || !key) return;
  try {
    if (ttlSeconds && ttlSeconds > 0) {
      await redis.set(key, value, { ex: ttlSeconds });
    } else {
      await redis.set(key, value);
    }
  } catch (err) {
    console.warn(`[Redis Cache SET Error] Key: ${key}:`, err);
  }
}

/**
 * Safely deletes one or more keys from Redis.
 */
export async function cacheDel(
  redis: Redis | null,
  ...keys: string[]
): Promise<void> {
  const validKeys = keys.filter(Boolean);
  if (!redis || validKeys.length === 0) return;
  try {
    await redis.del(...validKeys);
  } catch (err) {
    console.warn(`[Redis Cache DEL Error] Keys: ${validKeys.join(", ")}:`, err);
  }
}

/**
 * Invalidates all public client catalog caches.
 * Call this when an admin modifies products, categories, or add-ons.
 */
export async function invalidatePublicCatalogCache(redis: Redis | null): Promise<void> {
  if (!redis) return;
  await cacheDel(
    redis,
    CACHE_KEYS.MENU_CATEGORIES,
    CACHE_KEYS.ADDONS,
    CACHE_KEYS.CONFIG_VERSION,
  );
}

/**
 * Invalidates public store operational settings (order windows, settings, holidays, off-days).
 * Call this when an admin modifies store operation timings.
 */
export async function invalidateStoreOperationsCache(redis: Redis | null): Promise<void> {
  if (!redis) return;
  await cacheDel(
    redis,
    CACHE_KEYS.ORDER_WINDOWS,
    CACHE_KEYS.ORDER_WINDOW_STATUS,
    CACHE_KEYS.ORDER_SETTINGS,
    CACHE_KEYS.WEEKLY_OFF,
    CACHE_KEYS.HOLIDAYS,
    CACHE_KEYS.CONFIG_VERSION,
  );
}
