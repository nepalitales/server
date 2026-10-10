import type { Context, Next } from "hono";
import type { AppBindings } from "../config/app";

/**
 * Simple sliding-window rate limiter for Cloudflare Workers.
 *
 * Uses a module-scoped Map that persists within a single isolate.
 * This provides per-isolate protection — not globally perfect,
 * but a meaningful first line of defense against brute-force.
 *
 * For stronger guarantees, layer Cloudflare Rate Limiting Rules
 * on top via the dashboard (zero code, globally enforced).
 */

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// Periodically evict stale entries to prevent memory leaks
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute
let lastCleanup = Date.now();

function cleanup(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

/**
 * Creates a rate-limiting middleware.
 *
 * @param maxRequests - Max requests allowed within the window
 * @param windowMs - Time window in milliseconds
 */
export function rateLimit(maxRequests: number, windowMs: number) {
  return async function rateLimitMiddleware(
    c: Context<AppBindings>,
    next: Next,
  ): Promise<Response | void> {
    // Use CF-Connecting-IP (Cloudflare provides this), fall back to basic header
    const ip =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";

    const now = Date.now();
    cleanup(windowMs);

    const entry = store.get(ip) || { timestamps: [] };

    // Drop timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      const oldestInWindow = entry.timestamps[0]!;
      const retryAfterSec = Math.ceil((oldestInWindow + windowMs - now) / 1000);

      return c.json(
        {
          success: false,
          message: "Too many login attempts. Please try again later.",
        },
        429,
        {
          "Retry-After": String(retryAfterSec),
        },
      );
    }

    entry.timestamps.push(now);
    store.set(ip, entry);

    await next();
  };
}
