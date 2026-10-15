import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { verifyPassword, generateSessionToken } from "../../lib/crypto";
import { loginSchema } from "../../schemas";
import { formatZodErrors } from "../../utils";
import { authMiddleware, invalidateAdminSessionCache } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import type { AdminDoc, SessionDoc } from "../../types";

const SESSION_COOKIE = "admin_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

// 5 login attempts per 15 minutes per IP (globally enforced via Upstash Redis)
const loginRateLimit = rateLimit(5, 15 * 60 * 1000, {
  prefix: "rl:admin:login",
  errorMessage: "Too many login attempts. Please wait 15 minutes before trying again.",
});

const authRoutes = new Hono<AppBindings>();

/**
 * POST /auth/login
 *
 * Authenticates admin via email or phone + password.
 * Creates a session and sets an HttpOnly cookie.
 * Rate-limited to 5 attempts per 15 minutes per IP.
 */
authRoutes.post("/login", loginRateLimit, async (c) => {
  try {
    const body = await c.req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ success: false, message: "Invalid request data", errors: formatZodErrors(parsed.error) }, 400);
    }

    const { identifier, password } = parsed.data;
    const db = c.get("db");
    const admins = db.collection<AdminDoc>(COLLECTIONS.ADMINS);

    // Look up by email or phone -- single query with $or
    const normalizedIdentifier = identifier.trim().toLowerCase();
    const admin = await admins.findOne({
      $or: [
        { email: normalizedIdentifier },
        { phone: identifier.replace(/[\s-]/g, "") },
      ],
    });

    if (!admin) {
      return c.json({ success: false, message: "Invalid credentials" }, 401);
    }

    const isValid = await verifyPassword(password, admin.passwordHash);
    if (!isValid) {
      return c.json({ success: false, message: "Invalid credentials" }, 401);
    }

    // Create session
    const token = generateSessionToken();
    const sessions = db.collection<SessionDoc>(COLLECTIONS.SESSIONS);

    await sessions.insertOne({
      token,
      adminId: admin.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + SESSION_MAX_AGE * 1000),
    });

    // Set HttpOnly cookie (supports both modern SameSite=None on HTTPS and Lax on HTTP)
    const isProduction = c.env.NODE_ENV === "production";
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "None" : "Lax",
      maxAge: SESSION_MAX_AGE,
      path: "/",
    });

    return c.json({
      success: true,
      message: "Login successful",
      token,
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * POST /auth/logout
 *
 * Invalidates the session and clears the cookie.
 */
authRoutes.post("/logout", authMiddleware, async (c) => {
  try {
    const db = c.get("db");
    const sessions = db.collection<SessionDoc>(COLLECTIONS.SESSIONS);
    const adminId = c.get("adminId");

    // Delete all sessions for this admin (logout everywhere)
    await sessions.deleteMany({ adminId });
    invalidateAdminSessionCache();

    deleteCookie(c, SESSION_COOKIE, { path: "/" });

    return c.json({
      success: true,
      message: "Logout successful",
    });
  } catch (error) {
    console.error("Logout error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * GET /auth/me
 *
 * Returns the currently authenticated admin.
 */
authRoutes.get("/me", authMiddleware, async (c) => {
  try {
    const adminId = c.get("adminId");
    const db = c.get("db");
    const admins = db.collection<AdminDoc>(COLLECTIONS.ADMINS);

    const admin = await admins.findOne(
      { id: adminId },
      { projection: { passwordHash: 0, _id: 0 } },
    );

    if (!admin) {
      return c.json({ success: false, message: "Admin not found" }, 401);
    }

    return c.json({
      success: true,
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone,
      },
    });
  } catch (error) {
    console.error("Get admin error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { authRoutes };
