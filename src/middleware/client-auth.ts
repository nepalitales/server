import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "../config/app";
import { COLLECTIONS } from "../lib/db";
import type { ClientSessionDoc, ClientUserDoc } from "../types";

export const CLIENT_SESSION_COOKIE = "client_session";

/**
 * Authentication middleware for Client / Customer users.
 *
 * Supports both:
 * 1. HttpOnly cookie: `client_session`
 * 2. Authorization header: `Bearer <token>`
 *
 * Sets `userId` and `user` on Hono context for downstream handlers.
 */
export async function clientAuthMiddleware(
  c: Context<AppBindings>,
  next: Next,
): Promise<Response | void> {
  const authHeader = c.req.header("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  const cookieToken = getCookie(c, CLIENT_SESSION_COOKIE);
  const token = bearerToken || cookieToken;

  if (!token) {
    return c.json(
      {
        success: false,
        message: "Authentication required. Please sign in with your email.",
      },
      401,
    );
  }

  try {
    const db = c.get("db");
    const sessions = db.collection<ClientSessionDoc>(COLLECTIONS.CLIENT_SESSIONS);
    const users = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);

    const session = await sessions.findOne({
      token,
      expiresAt: { $gt: new Date() },
    });

    if (!session) {
      return c.json(
        {
          success: false,
          message: "Session expired or invalid. Please sign in again.",
        },
        401,
      );
    }

    const user = await users.findOne({ id: session.userId });

    if (!user) {
      return c.json(
        {
          success: false,
          message: "User account not found.",
        },
        401,
      );
    }

    c.set("userId", user.id);
    c.set("user", user);

    await next();
  } catch (error) {
    console.error("Client auth middleware error:", error);
    return c.json({ success: false, message: "Authentication failed" }, 401);
  }
}
