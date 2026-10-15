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
    ttlSeconds: 300,
    browserMaxAge: 0,
    edgeMaxAge: 0,
  },
  "/api/client/order-windows": {
    key: () => CACHE_KEYS.ORDER_WINDOWS,
    ttlSeconds: 300,
    browserMaxAge: 0,
    edgeMaxAge: 0,
  },
  "/api/client/order-window-status": {
    key: () => CACHE_KEYS.ORDER_WINDOW_STATUS,
    ttlSeconds: 30,
    browserMaxAge: 0,
    edgeMaxAge: 0,
  },
  "/api/client/order-settings": {
    key: () => CACHE_KEYS.ORDER_SETTINGS,
    ttlSeconds: 300,
    browserMaxAge: 0,
    edgeMaxAge: 0,
  },
  "/api/client/weekly-off": {
    key: () => CACHE_KEYS.WEEKLY_OFF,
    ttlSeconds: 300,
    browserMaxAge: 0,
    edgeMaxAge: 0,
  },
  "/api/client/holidays": {
    key: () => CACHE_KEYS.HOLIDAYS,
    ttlSeconds: 300,
    browserMaxAge: 0,
    edgeMaxAge: 0,
  },
  "/api/client/addons": {
    key: () => CACHE_KEYS.ADDONS,
    ttlSeconds: 300,
    browserMaxAge: 0,
    edgeMaxAge: 0,
  },
  "/api/client/config": {
    key: () => "cache:client:config_snapshot",
    ttlSeconds: 300,
    browserMaxAge: 0,
    edgeMaxAge: 0,
  },
  "/api/client/config-version": {
    key: () => CACHE_KEYS.CONFIG_VERSION,
    ttlSeconds: 60,
    browserMaxAge: 0,
    edgeMaxAge: 0,
  },
  "/api/client/faqs": {
    key: (c) => `${CACHE_KEYS.FAQS}:${c.req.query("category") || "all"}`,
    ttlSeconds: 3600,
    browserMaxAge: 60,
    edgeMaxAge: 300,
  },
};

// ─── Tier 1: Isolate-Level In-Memory Cache (< 0.05ms, 0 subrequests) ───────
interface MemoryEntry {
  data: unknown;
  expiresAt: number;
}
const memoryCache = new Map<string, MemoryEntry>();
const MAX_MEMORY_ITEMS = 250;

export function invalidateLocalMemoryCache(): void {
  memoryCache.clear();
}

function getFromMemory(key: string): unknown | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.data;
}

function setToMemory(key: string, data: unknown, ttlSeconds: number): void {
  if (memoryCache.size >= MAX_MEMORY_ITEMS) {
    // Evict oldest 50 items
    let count = 0;
    for (const k of memoryCache.keys()) {
      memoryCache.delete(k);
      if (++count >= 50) break;
    }
  }
  // Store in isolate RAM up to 60s or configured TTL, whichever is smaller
  const ramTtlMs = Math.min(ttlSeconds * 1000, 60_000);
  memoryCache.set(key, { data, expiresAt: Date.now() + ramTtlMs });
}

// ─── Tier 2: Cloudflare Native Cache API (1–2ms, 0 external subrequests) ───
function getCfCache(): Cache | null {
  try {
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

/**
 * High-performance Multi-Tier Edge Cache Middleware:
 * - Tier 1: Isolate RAM (< 0.05ms, 0 subrequests)
 * - Tier 2: Cloudflare Native Cache API (1-2ms, 0 external subrequests)
 * - Tier 3: Upstash Redis fallback (140-150ms)
 * - Cache Miss: Proceeds to handler, then saves to L1, L2, L3 asynchronously in background
 *   using waitUntil() so the client response is NEVER blocked by cache saves.
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

  const cacheKey = config.key(c);
  const cacheControlHeader =
    config.browserMaxAge > 0
      ? `public, max-age=${config.browserMaxAge}, s-maxage=${config.edgeMaxAge}, stale-while-revalidate=300`
      : "no-cache, no-store, must-revalidate";

  // 1. Tier 1: Check In-Memory RAM Cache
  const memoryData = getFromMemory(cacheKey);
  if (memoryData) {
    c.header("X-Cache", "HIT-L1-RAM");
    c.header("Cache-Control", cacheControlHeader);
    return c.json(memoryData);
  }

  // 2. Tier 2: Check Cloudflare Cache API (caches.default)
  const cfCache = getCfCache();
  const requestUrl = c.req.url;

  if (cfCache && config.edgeMaxAge > 0) {
    try {
      const matched = await cfCache.match(requestUrl);
      if (matched) {
        // Hydrate L1 memory cache in background for subsequent zero-latency hits
        try {
          const clone = matched.clone();
          const json = await clone.json();
          setToMemory(cacheKey, json, config.ttlSeconds);
        } catch {
          // ignore parsing error
        }

        const headers = new Headers(matched.headers);
        headers.set("X-Cache", "HIT-L2-EDGE");
        return new Response(matched.body, {
          status: matched.status,
          headers,
        });
      }
    } catch {
      // Non-fatal: proceed to Tier 3
    }
  }

  // 3. Tier 3: Upstash Redis fallback
  const redis = getRedisClient(c.env);
  if (redis) {
    try {
      const redisData = await cacheGet<Record<string, unknown>>(redis, cacheKey);
      if (redisData) {
        setToMemory(cacheKey, redisData, config.ttlSeconds);

        // Populate Cloudflare Cache API in background
        if (cfCache && config.edgeMaxAge > 0 && c.executionCtx?.waitUntil) {
          const edgeRes = new Response(JSON.stringify(redisData), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": cacheControlHeader,
              "X-Cache": "HIT-L2-EDGE",
            },
          });
          c.executionCtx.waitUntil(cfCache.put(requestUrl, edgeRes).catch(() => {}));
        }

        c.header("X-Cache", "HIT-L3-REDIS");
        c.header("Cache-Control", cacheControlHeader);
        return c.json(redisData);
      }
    } catch {
      // Fallback to database
    }
  }

  // 4. Cache MISS: Proceed to database route handler
  c.header("X-Cache", "MISS");
  await next();

  // If handler succeeded with 200, save response in L1, L2, and L3
  if (c.res.status === 200) {
    try {
      const clonedRes = c.res.clone();
      const jsonData = await clonedRes.json();

      // Immediately save in L1 RAM
      setToMemory(cacheKey, jsonData, config.ttlSeconds);

      // Save to L2 (Cloudflare Cache API) and L3 (Upstash Redis) asynchronously
      const bgTasks: Promise<unknown>[] = [];

      if (cfCache && config.edgeMaxAge > 0) {
        const edgeRes = new Response(JSON.stringify(jsonData), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": cacheControlHeader,
            "X-Cache": "HIT-L2-EDGE",
          },
        });
        bgTasks.push(cfCache.put(requestUrl, edgeRes).catch(() => {}));
      }

      if (redis) {
        bgTasks.push(cacheSet(redis, cacheKey, jsonData, config.ttlSeconds));
      }

      // In Cloudflare Workers, waitUntil ensures background tasks finish without blocking the HTTP response
      if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(Promise.all(bgTasks));
      } else {
        void Promise.all(bgTasks);
      }
    } catch {
      // Non-fatal: continue normally
    }
  }
}

