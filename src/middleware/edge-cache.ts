import type { Context, Next } from "hono";
import type { AppBindings } from "../config/app";
import { getRedisClient, cacheGet, cacheSet, CACHE_KEYS } from "../lib/redis";

interface CacheConfig {
  key: (c: Context<AppBindings>) => string;
  ttlSeconds: number;
  browserMaxAge: number;
  edgeMaxAge: number;
}

const PUBLIC_CACHE_ROUTES: Record<string, CacheConfig> = {
  "/api/client/categories": {
    key: () => CACHE_KEYS.MENU_CATEGORIES,
    ttlSeconds: 600, // 10 minutes in Redis
    browserMaxAge: 30,
    edgeMaxAge: 120,
  },
  "/api/client/order-windows": {
    key: () => CACHE_KEYS.ORDER_WINDOWS,
    ttlSeconds: 300, // 5 minutes in Redis
    browserMaxAge: 30,
    edgeMaxAge: 120,
  },
  "/api/client/order-window-status": {
    key: () => CACHE_KEYS.ORDER_WINDOW_STATUS,
    ttlSeconds: 30, // 30 seconds in Redis
    browserMaxAge: 10,
    edgeMaxAge: 30,
  },
  "/api/client/order-settings": {
    key: () => CACHE_KEYS.ORDER_SETTINGS,
    ttlSeconds: 3600, // 1 hour in Redis
    browserMaxAge: 60,
    edgeMaxAge: 300,
  },
  "/api/client/weekly-off": {
    key: () => CACHE_KEYS.WEEKLY_OFF,
    ttlSeconds: 3600,
    browserMaxAge: 60,
    edgeMaxAge: 300,
  },
  "/api/client/holidays": {
    key: () => CACHE_KEYS.HOLIDAYS,
    ttlSeconds: 3600,
    browserMaxAge: 60,
    edgeMaxAge: 300,
  },
  "/api/client/addons": {
    key: () => CACHE_KEYS.ADDONS,
    ttlSeconds: 3600,
    browserMaxAge: 60,
    edgeMaxAge: 300,
  },
  "/api/client/config": {
    key: () => "cache:client:config_snapshot",
    ttlSeconds: 300,
    browserMaxAge: 30,
    edgeMaxAge: 120,
  },
  "/api/client/config-version": {
    key: () => CACHE_KEYS.CONFIG_VERSION,
    ttlSeconds: 60,
    browserMaxAge: 5,
    edgeMaxAge: 10,
  },
  "/api/client/faqs": {
    key: (c) => `${CACHE_KEYS.FAQS}:${c.req.query("category") || "all"}`,
    ttlSeconds: 3600,
    browserMaxAge: 60,
    edgeMaxAge: 300,
  },
};

/**
 * High-performance edge cache middleware.
 *
 * Runs BEFORE database connection middleware:
 * - Cache HIT: Returns directly from Upstash Redis in < 15ms. MongoDB is never touched.
 * - Cache MISS: Proceeds to dbMiddleware and route handler, then writes result to Redis.
 */
export async function edgeCacheMiddleware(
  c: Context<AppBindings>,
  next: Next,
): Promise<Response | void> {
  // Only cache GET requests
  if (c.req.method !== "GET") {
    await next();
    return;
  }

  const path = c.req.path;
  const config = PUBLIC_CACHE_ROUTES[path];

  // If this route is not in the cache manifest, pass through
  if (!config) {
    await next();
    return;
  }

  const redis = getRedisClient(c.env);
  if (!redis) {
    await next();
    return;
  }

  const cacheKey = config.key(c);

  try {
    const cachedData = await cacheGet<Record<string, unknown>>(redis, cacheKey);
    if (cachedData) {
      c.header("X-Cache", "HIT");
      c.header(
        "Cache-Control",
        `public, max-age=${config.browserMaxAge}, s-maxage=${config.edgeMaxAge}, stale-while-revalidate=300`,
      );
      return c.json(cachedData);
    }
  } catch (err) {
    console.warn(`[Edge Cache Middleware] Error checking key ${cacheKey}:`, err);
  }

  // Cache MISS: proceed to DB handler
  c.header("X-Cache", "MISS");
  await next();

  // If handler succeeded with 200, save response in Upstash Redis
  if (c.res.status === 200) {
    try {
      const clonedRes = c.res.clone();
      const jsonData = await clonedRes.json();

      const savePromise = cacheSet(redis, cacheKey, jsonData, config.ttlSeconds);

      // In Cloudflare Workers, waitUntil runs in the background without blocking the HTTP response
      if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(savePromise);
      } else {
        await savePromise;
      }
    } catch {
      // Non-fatal: if response is not valid JSON or saving fails, continue normally
    }
  }
}
