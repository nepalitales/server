import type { Context, Next } from "hono";
import type { AppBindings } from "../config/app";
import { CACHE_KEYS } from "../lib/redis";

interface CacheConfig {
  key: (c: Context<AppBindings>) => string;
  ttlSeconds: number;
  browserMaxAge: number;
  edgeMaxAge: number;
}

const PUBLIC_CACHE_ROUTES: Record<string, CacheConfig> = {
  "/api/client/categories": {
    key: () => CACHE_KEYS.MENU_CATEGORIES,
    ttlSeconds: 600, // 10 minutes
    browserMaxAge: 60,
    edgeMaxAge: 300,
  },
  "/api/client/addons": {
    key: () => CACHE_KEYS.ADDONS,
    ttlSeconds: 3600,
    browserMaxAge: 60,
    edgeMaxAge: 300,
  },
  "/api/client/order-settings": {
    key: () => CACHE_KEYS.ORDER_SETTINGS,
    ttlSeconds: 3600,
    browserMaxAge: 60,
    edgeMaxAge: 300,
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
 * - Cache Miss: Proceeds to handler, then saves to L1 RAM & L2 Cloudflare Cache
 *   asynchronously using waitUntil() without consuming Upstash Redis commands.
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

  // Bypass cache if authenticated user or tester parameter is present
  if (c.req.header("authorization") || c.req.query("tester")) {
    await next();
    return;
  }

  const cacheKey = config.key(c);
  const cacheControlHeader = `public, max-age=${config.browserMaxAge}, s-maxage=${config.edgeMaxAge}, stale-while-revalidate=300`;

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

  if (cfCache) {
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

  // 3. Cache MISS: Proceed to database route handler
  c.header("X-Cache", "MISS");
  await next();

  // If handler succeeded with 200, save response in L1 RAM and L2 Cloudflare Cache
  if (c.res.status === 200) {
    try {
      const clonedRes = c.res.clone();
      const jsonData = await clonedRes.json();

      // Immediately save in L1 RAM
      setToMemory(cacheKey, jsonData, config.ttlSeconds);

      // Save to L2 (Cloudflare Native Cache API) asynchronously in background
      if (cfCache && c.executionCtx?.waitUntil) {
        const edgeRes = new Response(JSON.stringify(jsonData), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": cacheControlHeader,
            "X-Cache": "HIT-L2-EDGE",
          },
        });
        c.executionCtx.waitUntil(cfCache.put(requestUrl, edgeRes).catch(() => {}));
      }
    } catch {
      // Non-fatal: continue normally
    }
  }
}

