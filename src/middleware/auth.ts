import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "../config/app";
import { COLLECTIONS } from "../lib/db";
import type { SessionDoc } from "../types";

const SESSION_COOKIE = "admin_session";

/**
 * Authentication middleware.
 *
 * Validates the session token from:
 * 1. Authorization: Bearer <token> header (cross-origin SPAs like Vercel)
 * 2. ?token=<token> URL query parameter (for EventSource SSE)
 * 3. admin_session HttpOnly cookie (same-origin / cookie-enabled clients)
 *
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

  const queryToken = c.req.query("token");
  const cookieToken = getCookie(c, SESSION_COOKIE);
  const token = bearerToken || queryToken || cookieToken;

  if (!token) {
    return c.json({ success: false, message: "Authentication required" }, 401);
  }

  try {
    const db = c.get("db");
    const sessions = db.collection<SessionDoc>(COLLECTIONS.SESSIONS);

    const session = await sessions.findOne({
      token,
      expiresAt: { $gt: new Date() },
    });

    if (!session) {
      return c.json({ success: false, message: "Session expired or invalid" }, 401);
    }

    c.set("adminId", session.adminId);
    await next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return c.json({ success: false, message: "Authentication failed" }, 401);
  }
}
