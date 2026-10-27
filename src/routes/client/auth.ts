import { Hono, type Context } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { generateSessionToken, generateId } from "../../lib/crypto";
import { generateNumericOtp, hashOtp, verifyOtp } from "../../lib/otp";
import { sendEmailOtp } from "../../lib/email";
import {
  requestOtpSchema,
  verifyOtpSchema,
  setUsernameSchema,
  updateClientProfileSchema,
} from "../../schemas";
import { formatZodErrors } from "../../utils";
import {
  clientAuthMiddleware,
  CLIENT_SESSION_COOKIE,
} from "../../middleware/client-auth";
import type {
  ClientUserDoc,
  ClientSessionDoc,
  ClientOtpDoc,
  OrderDoc,
} from "../../types";
import { getRedisClient, cacheDel, CACHE_KEYS } from "../../lib/redis";
import { rateLimit } from "../../middleware/rate-limit";

const clientAuthRoutes = new Hono<AppBindings>();

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds cooldown between resends

// 4 requests per 15 minutes per IP/identifier globally enforced via Upstash Redis
const otpRateLimit = rateLimit(4, 15 * 60 * 1000, {
  prefix: "rl:client:otp",
  errorMessage: "Too many OTP requests from your network. Please wait 15 minutes before trying again.",
});

// ─── 1. Send OTP (Email via Resend only) ──────────────────────────

/**
 * POST /api/client/auth/send-otp
 * (Also mounted as POST /api/client/auth/signin)
 *
 * Body: { email: "customer@gmail.com" }
 */
async function handleSendOtp(c: Context<AppBindings>) {
  try {
    const body = await c.req.json();
    const parsed = requestOtpSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Please provide a valid email address",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const email = parsed.data.email.toLowerCase().trim();
    const identifier = email;
    const channel = "email";

    const db = c.get("db");
    const otps = db.collection<ClientOtpDoc>(COLLECTIONS.CLIENT_OTPS);
    const users = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);
    const clientIp =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";

    // ─── Rate-Limiting Defense ───────────────────────────────────────
    // 1. Minimum 60-second cooldown between resends
    // 2. Maximum 4 OTP requests per 15 minutes per target
    // 3. Maximum 10 OTP requests per 15 minutes per IP
    const existingOtp = await otps.findOne({
      $or: [{ identifier }, { email }],
    });
    const now = Date.now();

    if (
      existingOtp &&
      existingOtp.createdAt &&
      now - new Date(existingOtp.createdAt).getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      const waitSeconds = Math.ceil(
        (OTP_RESEND_COOLDOWN_MS - (now - new Date(existingOtp.createdAt).getTime())) / 1000,
      );
      return c.json(
        {
          success: false,
          message: `Please wait ${waitSeconds} seconds before requesting another code.`,
          retryAfter: waitSeconds,
        },
        429,
      );
    }

    // Check sliding window rate limit (15 minutes)
    const fifteenMinutesAgo = new Date(now - 15 * 60 * 1000);
    const recentRequests = (existingOtp?.requestHistory || []).filter(
      (ts) => new Date(ts).getTime() > fifteenMinutesAgo.getTime(),
    );

    if (recentRequests.length >= 4) {
      return c.json(
        {
          success: false,
          message: `Too many OTP requests for this ${channel}. Please wait 15 minutes before trying again.`,
        },
        429,
      );
    }

    // Check IP-based burst rate limit to prevent distributed bot abuse
    if (clientIp !== "unknown") {
      const ipRecentCount = await otps.countDocuments({
        lastIp: clientIp,
        createdAt: { $gte: fifteenMinutesAgo },
      });
      if (ipRecentCount >= 10) {
        return c.json(
          {
            success: false,
            message: "Too many verification requests from your network. Please wait 15 minutes.",
          },
          429,
        );
      }
    }

    // Generate 6-digit OTP and hash it with per-request salt and email binding
    const otp = generateNumericOtp(6);
    const otpHash = await hashOtp(otp, identifier);
    const expiresAt = new Date(now + OTP_EXPIRY_MS);
    const updatedHistory = [...recentRequests, new Date()];

    // Save/upsert OTP record in MongoDB
    await otps.updateOne(
      { identifier },
      {
        $set: {
          identifier,
          email,
          otpHash,
          attempts: 0,
          expiresAt,
          createdAt: new Date(),
          lastIp: clientIp,
          requestHistory: updatedHistory,
        },
      },
      { upsert: true },
    );

    const isDev = c.env.NODE_ENV === "development";

    const sendResult = await sendEmailOtp({
      email,
      otp,
      apiKey: c.env.RESEND_API_KEY,
      fromEmail: c.env.RESEND_FROM_EMAIL,
      isDevelopment: isDev,
    });

    if (!sendResult.success) {
      console.error("[Send OTP Error]:", sendResult.error);
      return c.json(
        {
          success: false,
          message: "Failed to send email verification code. Please try again later.",
        },
        500,
      );
    }

    const existingUser = await users.findOne({ email });

    return c.json({
      success: true,
      message: "Verification code sent to your email",
      channel,
      email,
      isExistingUser: !!existingUser,
      provider: sendResult.provider,
      ...(isDev ? { devOtp: otp } : {}),
    });
  } catch (error) {
    console.error("Send OTP error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
}

clientAuthRoutes.post("/send-otp", otpRateLimit, handleSendOtp);
clientAuthRoutes.post("/signin", otpRateLimit, handleSendOtp);

// ─── 2. Verify OTP & Authenticate / Register ────────────────────────

/**
 * POST /api/client/auth/verify-otp
 *
 * Verifies the 6-digit OTP entered by the user.
 * If user is new and provides a username, creates user with that username.
 * If user is existing and provides a username, updates their username.
 * Returns session token, sets HttpOnly cookie, and returns user profile.
 *
 * Body: { email: "customer@gmail.com", otp: "123456", username?: "Ankit" }
 */
clientAuthRoutes.post("/verify-otp", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = verifyOtpSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid verification data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const email = parsed.data.email.toLowerCase().trim();
    const identifier = email;
    const { otp, username } = parsed.data;

    const db = c.get("db");
    const otps = db.collection<ClientOtpDoc>(COLLECTIONS.CLIENT_OTPS);
    const users = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);
    const sessions = db.collection<ClientSessionDoc>(COLLECTIONS.CLIENT_SESSIONS);

    // Find active OTP record
    const otpDoc = await otps.findOne({
      $or: [{ identifier }, { email }],
    });

    if (!otpDoc) {
      return c.json(
        {
          success: false,
          message: "Verification code not found or expired. Please request a new code.",
        },
        400,
      );
    }

    // Check expiration
    if (new Date(otpDoc.expiresAt).getTime() < Date.now()) {
      await otps.deleteOne({ _id: otpDoc._id });
      return c.json(
        {
          success: false,
          message: "Verification code has expired. Please request a new one.",
        },
        400,
      );
    }

    // Check brute-force attempts limit
    if (otpDoc.attempts >= 5) {
      await otps.deleteOne({ _id: otpDoc._id });
      return c.json(
        {
          success: false,
          message: "Too many incorrect attempts. Please request a new code.",
        },
        400,
      );
    }

    // Verify OTP with timing-safe comparison
    const isValid = await verifyOtp(otp, otpDoc.otpHash, identifier);
    if (!isValid) {
      const remaining = 4 - otpDoc.attempts;
      await otps.updateOne(
        { _id: otpDoc._id },
        { $inc: { attempts: 1 } },
      );

      return c.json(
        {
          success: false,
          message:
            remaining > 0
              ? `Incorrect verification code. ${remaining} attempt(s) remaining.`
              : "Incorrect verification code. Please request a new one.",
        },
        400,
      );
    }

    // Code is valid -- remove OTP immediately (one-time use)
    await otps.deleteOne({ _id: otpDoc._id });

    // Look up or create user
    let user: ClientUserDoc | null = await users.findOne({ email });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const newUser: ClientUserDoc = {
        id: generateId("user"),
        email,
        username: username?.trim() || "",
        isVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await users.insertOne(newUser as any);
      user = newUser;
    } else {
      const updateFields: Record<string, unknown> = {
        isVerified: true,
        updatedAt: new Date(),
        email,
      };
      if (username && username.trim() !== user.username) {
        updateFields.username = username.trim();
        user.username = username.trim();
      }

      await users.updateOne({ id: user.id }, { $set: updateFields });
      user.email = email;
    }

    if (!user) {
      return c.json({ success: false, message: "Failed to initialize user" }, 500);
    }

    // Auto-discover phone number and username from past orders if missing in client_users profile
    if (!user.username || !user.phone) {
      try {
        const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
        const queryConditions: Record<string, unknown>[] = [{ userId: user.id }];
        if (user.email) {
          queryConditions.push({ "customer.email": user.email.toLowerCase() });
        }
        const pastOrder = await ordersCol.findOne(
          { $or: queryConditions },
          { sort: { createdAt: -1 } }
        );

        if (pastOrder?.customer) {
          const backfillFields: Record<string, unknown> = {};
          if (!user.username && pastOrder.customer.name && pastOrder.customer.name.trim() !== "Customer") {
            user.username = pastOrder.customer.name.trim();
            backfillFields.username = pastOrder.customer.name.trim();
          }
          if (!user.phone && pastOrder.customer.phone && pastOrder.customer.phone.trim()) {
            user.phone = pastOrder.customer.phone.trim();
            backfillFields.phone = pastOrder.customer.phone.trim();
          }
          if (Object.keys(backfillFields).length > 0) {
            backfillFields.updatedAt = new Date();
            await users.updateOne({ id: user.id }, { $set: backfillFields });
          }
        }
      } catch (backfillErr) {
        console.warn("[Auth] Failed to backfill user profile from orders:", backfillErr);
      }
    }

    // Create session token
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

    await sessions.insertOne({
      token,
      userId: user.id,
      createdAt: new Date(),
      expiresAt,
    });

    // Set HttpOnly cookie
    const isHttps = c.req.url.startsWith("https://");
    const isLocalhost = c.req.url.includes("localhost") || c.req.url.includes("127.0.0.1");
    const isSecure = isHttps || (c.env.NODE_ENV === "production" && !isLocalhost);

    setCookie(c, CLIENT_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "Lax",
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });

    return c.json({
      success: true,
      message: "Successfully signed in",
      token,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        username: user.username,
        isVerified: user.isVerified,
      },
      isNewUser,
      requiresUsername: !user.username,
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 3. Set or Update Username ─────────────────────────────────────

/**
 * POST /api/client/auth/username
 *
 * Sets or updates the customer's display username.
 * Protected by clientAuthMiddleware.
 *
 * Body: { username: "Ankit Bhavarthe" }
 */
clientAuthRoutes.patch("/profile", clientAuthMiddleware, async (c) => {
  try {
    const body = await c.req.json();
    const parsed = updateClientProfileSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid profile data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    if (!parsed.data.username && !parsed.data.phone) {
      return c.json({ success: false, message: "No fields to update" }, 400);
    }

    const userId = c.get("userId")!;
    const db = c.get("db");
    const users = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);
    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.username) setFields.username = parsed.data.username;
    if (parsed.data.phone) setFields.phone = parsed.data.phone;

    await users.updateOne({ id: userId }, { $set: setFields });
    const updatedUser = await users.findOne({ id: userId });

    return c.json({
      success: true,
      message: "Profile updated",
      user: {
        id: updatedUser?.id,
        phone: updatedUser?.phone,
        email: updatedUser?.email,
        username: updatedUser?.username,
        isVerified: updatedUser?.isVerified,
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

clientAuthRoutes.post("/username", clientAuthMiddleware, async (c) => {
  try {
    const body = await c.req.json();
    const parsed = setUsernameSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid username",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const newUsername = parsed.data.username;
    const userId = c.get("userId")!;
    const db = c.get("db");
    const users = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);

    await users.updateOne(
      { id: userId },
      {
        $set: {
          username: newUsername,
          updatedAt: new Date(),
        },
      },
    );

    const updatedUser = await users.findOne({ id: userId });

    return c.json({
      success: true,
      message: "Username updated successfully",
      user: {
        id: updatedUser?.id,
        phone: updatedUser?.phone,
        email: updatedUser?.email,
        username: updatedUser?.username,
        isVerified: updatedUser?.isVerified,
      },
    });
  } catch (error) {
    console.error("Update username error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 4. Current User Profile ───────────────────────────────────────

/**
 * GET /api/client/auth/me
 *
 * Returns current authenticated customer's profile.
 * Protected by clientAuthMiddleware.
 */
clientAuthRoutes.get("/me", clientAuthMiddleware, async (c) => {
  const user = c.get("user")!;
  const db = c.get("db");

  // Auto-discover phone number and username from past orders if missing in client_users profile
  if (!user.username || !user.phone) {
    try {
      const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
      const queryConditions: Record<string, unknown>[] = [{ userId: user.id }];
      if (user.email) {
        queryConditions.push({ "customer.email": user.email.toLowerCase() });
      }
      const pastOrder = await ordersCol.findOne(
        { $or: queryConditions },
        { sort: { createdAt: -1 } }
      );

      if (pastOrder?.customer) {
        const backfillFields: Record<string, unknown> = {};
        if (!user.username && pastOrder.customer.name && pastOrder.customer.name.trim() !== "Customer") {
          user.username = pastOrder.customer.name.trim();
          backfillFields.username = pastOrder.customer.name.trim();
        }
        if (!user.phone && pastOrder.customer.phone && pastOrder.customer.phone.trim()) {
          user.phone = pastOrder.customer.phone.trim();
          backfillFields.phone = pastOrder.customer.phone.trim();
        }
        if (Object.keys(backfillFields).length > 0) {
          backfillFields.updatedAt = new Date();
          const usersCol = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);
          await usersCol.updateOne({ id: user.id }, { $set: backfillFields });
        }
      }
    } catch (backfillErr) {
      console.warn("[Auth] Failed to backfill user profile from orders in /me:", backfillErr);
    }
  }

  return c.json({
    success: true,
    user: {
      id: user.id,
      phone: user.phone,
      email: user.email,
      username: user.username,
      isVerified: user.isVerified,
    },
  });
});

// ─── 5. Logout ─────────────────────────────────────────────────────

/**
 * POST /api/client/auth/logout
 *
 * Invalidates the customer's session and clears the cookie.
 */
clientAuthRoutes.post("/logout", async (c) => {
  try {
    const authHeader = c.req.header("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    const cookieToken = getCookie(c, CLIENT_SESSION_COOKIE);
    const token = bearerToken || cookieToken;

    if (token) {
      const db = c.get("db");
      const sessions = db.collection<ClientSessionDoc>(COLLECTIONS.CLIENT_SESSIONS);
      await sessions.deleteOne({ token });

      const redis = getRedisClient(c.env);
      if (redis) {
        cacheDel(redis, `${CACHE_KEYS.CLIENT_SESSION_PREFIX}${token}`).catch(() => {});
      }
    }

    deleteCookie(c, CLIENT_SESSION_COOKIE, { path: "/" });

    return c.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Client logout error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});
clientAuthRoutes.post("/signout", async (c) => {
  try {
    const authHeader = c.req.header("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    const cookieToken = getCookie(c, CLIENT_SESSION_COOKIE);
    const token = bearerToken || cookieToken;

    if (token) {
      const db = c.get("db");
      const sessions = db.collection<ClientSessionDoc>(COLLECTIONS.CLIENT_SESSIONS);
      await sessions.deleteOne({ token });

      const redis = getRedisClient(c.env);
      if (redis) {
        cacheDel(redis, `${CACHE_KEYS.CLIENT_SESSION_PREFIX}${token}`).catch(() => {});
      }
    }

    deleteCookie(c, CLIENT_SESSION_COOKIE, { path: "/" });

    return c.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Client logout error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { clientAuthRoutes };
