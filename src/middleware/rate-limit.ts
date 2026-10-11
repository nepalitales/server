import type { Context, Next } from "hono";
import { Ratelimit } from "@upstash/ratelimit";
import type { AppBindings } from "../config/app";
import { getRedisClient } from "../lib/redis";

/**
 * Resilient Multi-Tier Rate Limiter for Cloudflare Workers.
 *
 * Tier 1 (Primary): Upstash Redis Global Sliding Window (works across all 300+ CF edge locations).
 * Tier 2 (Fallback): In-memory Map sliding window (per-isolate defense if Redis is unavailable).
 */

interface LocalRateLimitEntry {
  timestamps: number[];
}

const localStore = new Map<string, LocalRateLimitEntry>();
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

function cleanupLocal(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of localStore) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
    if (entry.timestamps.length === 0) {
      localStore.delete(key);
    }
  }
}

export interface RateLimitOptions {
  maxRequests: number;
  windowMs: number;
  prefix?: string;
  errorMessage?: string;
  identifier?: (c: Context<AppBindings>) => string | Promise<string>;
}

export function rateLimit(
  maxRequests: number,
  windowMs: number,
  options: Partial<RateLimitOptions> = {},
) {
  const prefix = options.prefix || "rl:general";
  const errorMessage =
    options.errorMessage || "Too many requests. Please try again later.";
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async function rateLimitMiddleware(
    c: Context<AppBindings>,
    next: Next,
  ): Promise<Response | void> {
    const rawIp =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";

    const key = options.identifier ? await options.identifier(c) : rawIp;
    const redis = getRedisClient(c.env);

    // 1. Tier 1: Global Upstash Redis Rate Limiting
    if (redis) {
      try {
        const ratelimit = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(maxRequests, `${windowSeconds} s`),
          prefix,
          analytics: false,
        });

        const { success, limit, remaining, reset } = await ratelimit.limit(key);

        c.header("X-RateLimit-Limit", String(limit));
        c.header("X-RateLimit-Remaining", String(remaining));
        c.header("X-RateLimit-Reset", String(reset));

        if (!success) {
          const retryAfterSec = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
          return c.json(
            {
              success: false,
              message: errorMessage,
              retryAfter: retryAfterSec,
            },
            429,
            {
              "Retry-After": String(retryAfterSec),
            },
          );
        }

        await next();
        return;
      } catch (err) {
        console.warn("[RateLimit] Upstash rate limit error, falling back to local memory:", err);
      }
    }

    // 2. Tier 2: In-Memory Sliding Window Fallback
    const now = Date.now();
    cleanupLocal(windowMs);

    const entry = localStore.get(key) || { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      const oldestInWindow = entry.timestamps[0]!;
      const retryAfterSec = Math.ceil((oldestInWindow + windowMs - now) / 1000);

      return c.json(
        {
          success: false,
          message: errorMessage,
          retryAfter: retryAfterSec,
        },
        429,
        {
          "Retry-After": String(retryAfterSec),
        },
      );
    }

    entry.timestamps.push(now);
    localStore.set(key, entry);

    await next();
  };
}
