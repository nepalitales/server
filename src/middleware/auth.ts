import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "../config/app";
import { COLLECTIONS } from "../lib/db";
import { getRedisClient, cacheGet, cacheSet, cacheDel } from "../lib/redis";
import type { SessionDoc } from "../types";

const SESSION_COOKIE = "admin_session";
const ADMIN_SESSION_PREFIX = "cache:session:admin:";

// ─── Fast Isolate RAM Cache (< 0.05ms, 0 DB queries, 0 subrequests) ───────
interface AdminSessionMemoryEntry {
  adminId: string;
  expiresAt: number;
}
const adminSessionCache = new Map<string, AdminSessionMemoryEntry>();
const MAX_CACHED_SESSIONS = 100;

export function invalidateAdminSessionCache(token?: string) {
  if (token) {
    adminSessionCache.delete(token);
  } else {
    adminSessionCache.clear();
  }
}

/**
 * Authentication middleware.
 *
 * Validates the session token from:
 * 1. Authorization: Bearer <token> header (cross-origin SPAs like Vercel)
 * 2. ?token=<token> URL query parameter (for EventSource SSE)
 * 3. admin_session HttpOnly cookie (same-origin / cookie-enabled clients)
 *
 * Checks Isolate RAM (<0.05ms) -> Upstash Redis -> MongoDB Atlas.
 * Sets `c.set("adminId", ...)` for downstream handlers.
 */
export async function authMiddleware(
  c: Context<AppBindings>,
  next: Next,
): Promise<Response | void> {
  const authHeader = c.req.header("authorization") || c.req.header("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  // Prevent token leakage via access logs and browser histories:
  // Disallow ?token= on standard REST routes; only permit on explicit streaming/event endpoints
  const isStreamRoute = c.req.path.endsWith("/events") || c.req.path.endsWith("/stream");
  const queryToken = isStreamRoute ? c.req.query("token") : null;
  const cookieToken = getCookie(c, SESSION_COOKIE);
  const token = bearerToken || cookieToken || queryToken;

  if (!token) {
    return c.json({ success: false, message: "Authentication required" }, 401);
  }

  const now = Date.now();

  // 1. Tier 1: Check Isolate RAM Cache (< 0.05ms, zero network)
  const memEntry = adminSessionCache.get(token);
  if (memEntry && memEntry.expiresAt > now) {
    c.set("adminId", memEntry.adminId);
    await next();
    return;
  }

  // 2. Tier 2: Check Redis Session Cache
  const redis = getRedisClient(c.env);
  const redisKey = `${ADMIN_SESSION_PREFIX}${token}`;
  if (redis) {
    try {
      const cached = await cacheGet<{ adminId: string; expiresAt: number }>(redis, redisKey);
      if (cached && cached.adminId && cached.expiresAt > now) {
        adminSessionCache.set(token, {
          adminId: cached.adminId,
          expiresAt: Math.min(cached.expiresAt, now + 60_000), // Keep in RAM up to 60s
        });
        c.set("adminId", cached.adminId);
        await next();
        return;
      }
    } catch {
      // Fallback to database
    }
  }

  // 3. Tier 3: Database Lookup on Cache Miss
  try {
    const db = c.get("db");
    const sessions = db.collection<SessionDoc>(COLLECTIONS.SESSIONS);

    const session = await sessions.findOne({
      token,
      expiresAt: { $gt: new Date() },
    });

    if (!session) {
      adminSessionCache.delete(token);
      return c.json(
        {
          success: false,
          code: "SESSION_EXPIRED",
          message: "Session expired or invalid. Please sign in again.",
        },
        401,
      );
    }

    const sessionExpiryMs = new Date(session.expiresAt).getTime();
    const ramTtl = Math.min(sessionExpiryMs, now + 60_000); // 60s in RAM

    // Keep cache bounded
    if (adminSessionCache.size >= MAX_CACHED_SESSIONS) {
      const firstKey = adminSessionCache.keys().next().value;
      if (firstKey) adminSessionCache.delete(firstKey);
    }
    adminSessionCache.set(token, { adminId: session.adminId, expiresAt: ramTtl });

    // Populate Redis in background
    if (redis) {
      const redisTtlSec = Math.max(1, Math.floor((sessionExpiryMs - now) / 1000));
      cacheSet(redis, redisKey, { adminId: session.adminId, expiresAt: sessionExpiryMs }, redisTtlSec).catch(() => {});
    }

    c.set("adminId", session.adminId);
    await next();
  } catch (error) {
    console.error("Auth middleware database error:", error);
    return c.json(
      {
        success: false,
        code: "DB_UNAVAILABLE",
        message: "Database service temporarily unavailable. Please try again shortly.",
      },
      503,
    );
  }
}

