import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { timing } from "hono/timing";
import type { AppBindings } from "./config/app";
import { dbMiddleware } from "./config/app";
import { validateEnv } from "./config/env";
import { withSentry, captureException } from "./lib/sentry";
import { authMiddleware } from "./middleware/auth";
import { authRoutes } from "./routes/auth";
import { productRoutes } from "./routes/products";
import { categoryRoutes } from "./routes/categories";
import { orderWindowRoutes } from "./routes/order-windows";
import { weeklyOffRoutes } from "./routes/weekly-off";
import { holidayRoutes } from "./routes/holidays";
import { uploadRoutes } from "./routes/upload";
import { clientRoutes } from "./routes/client";
import { adminOrderRoutes } from "./routes/admin/orders";
import { razorpayWebhookRoutes } from "./routes/webhooks/razorpay";
import { faqRoutes } from "./routes/faqs";
import { adminDispatchWindowRoutes } from "./routes/admin/dispatch-windows";
import { addonRoutes } from "./routes/addons";
import { adminOrderSettingsRoutes } from "./routes/admin/order-settings";
import { getCachedConfigVersion } from "./lib/config-version";
import { edgeCacheMiddleware } from "./middleware/edge-cache";
import { streamSSE } from "hono/streaming";
import { liveWindowBroadcastHub } from "./lib/live-order-window";
import { getRedisClient, cacheGet, CACHE_KEYS } from "./lib/redis";

const app = new Hono<AppBindings>();

// --- Global Middleware ---

/**
 * Validate environment variables once per isolate.
 * In Workers, env is per-request but identical within an isolate,
 * so we cache the validation result after the first successful parse.
 */
let envValidated = false;

app.use("*", async (c, next) => {
  if (!envValidated) {
    try {
      validateEnv(c.env);
      envValidated = true;
    } catch (error) {
      console.error("Environment validation failed:", error);
      return c.json({ success: false, message: "Server misconfiguration" }, 500);
    }
  }
  await next();
});

// Security headers (HSTS, X-Content-Type-Options, etc.)
app.use("*", secureHeaders());

// Request timing header (Server-Timing)
app.use("*", timing());

// Request logging
app.use("*", logger());

// Strict allowlist of production origins permitted to make cross-origin requests
const ALLOWED_ORIGINS = new Set([
  "https://nepalitales.com",
  "https://www.nepalitales.com",
  "https://admin.nepalitales.com",
]);

// CORS -- allow only explicit production domains and local dev ports in non-production
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      // No origin header = direct API call (curl, server-to-server, mobile apps)
      // Return null to block browser requests without an Origin header
      if (!origin) return "https://nepalitales.com";

      if (ALLOWED_ORIGINS.has(origin)) return origin;

      const isNonProduction = (c.env as any)?.NODE_ENV !== "production";
      if (
        isNonProduction &&
        (origin.startsWith("http://localhost:") ||
          origin.startsWith("http://127.0.0.1:"))
      ) {
        return origin;
      }

      return "";
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    maxAge: 86400,
  }),
);

// Global Multi-Tier Edge Cache for public customer routes
// Returns response immediately from isolate RAM (< 0.05ms) or Cloudflare Cache API (1-2ms)
app.use("/api/client/*", edgeCacheMiddleware);

// Serve cached config-version without opening MongoDB
app.use("/api/client/config-version", async (c, next) => {
  if (c.req.method !== "GET") {
    await next();
    return;
  }
  const cached = getCachedConfigVersion();
  if (cached) {
    c.header(
      "Cache-Control",
      "public, max-age=5, s-maxage=10, stale-while-revalidate=30",
    );
    return c.json({ success: true, version: cached });
  }
  await next();
});

// Real-Time Live Order Window SSE Stream for Active Clients
// Completely bypasses MongoDB to prevent connection exhaustion.
// Zero DB connections held for the duration of the stream.
app.get("/api/client/live-window/stream", async (c) => {
  return streamSSE(c, async (stream) => {
    // 1. Send initial snapshot from Redis cache if available
    try {
      const redis = getRedisClient(c.env);
      const cached = redis ? await cacheGet<Record<string, unknown>>(redis, CACHE_KEYS.ORDER_WINDOW_STATUS) : null;
      await stream.writeSSE({
        event: "INIT",
        data: JSON.stringify(
          cached || {
            isOpen: true,
            message: "Connected to live order window real-time channel",
            timestamp: new Date().toISOString(),
          },
        ),
      });
    } catch {
      // Ignore cache lookup error on init
    }

    // 2. Subscribe to in-memory broadcast hub (O(1) memory, 0 DB queries)
    const unsubscribe = liveWindowBroadcastHub.subscribe(async (payload) => {
      try {
        await stream.writeSSE({
          event: "LIVE_WINDOW_EXTENDED",
          data: JSON.stringify(payload),
        });
      } catch {
        // Client stream disconnected
      }
    });

    let isStreamActive = true;
    const heartbeatInterval = setInterval(async () => {
      if (!isStreamActive) return;
      try {
        await stream.writeSSE({
          event: "PING",
          data: JSON.stringify({ ts: Date.now() }),
        });
      } catch {
        isStreamActive = false;
        clearInterval(heartbeatInterval);
        unsubscribe();
      }
    }, 25_000);

    stream.onAbort(() => {
      isStreamActive = false;
      clearInterval(heartbeatInterval);
      unsubscribe();
    });

    while (isStreamActive) {
      await stream.sleep(20_000);
    }
  });
});

// Database connection -- opens per-request, closes in finally block
app.use("/api/admin/*", dbMiddleware);
app.use("/api/client/*", dbMiddleware);
app.use("/api/webhooks/*", dbMiddleware);

// --- Health Check (protected) ---

app.get("/api/admin/health", authMiddleware, (c) => {
  return c.json({
    success: true,
    message: "Nepali Tales Admin API is running",
    timestamp: new Date().toISOString(),
  });
});

// --- Route Mounts ---

app.route("/api/admin/auth", authRoutes);
app.route("/api/admin/products", productRoutes);
app.route("/api/admin/categories", categoryRoutes);
app.route("/api/admin/order-windows", orderWindowRoutes);
app.route("/api/admin/weekly-off", weeklyOffRoutes);
app.route("/api/admin/holidays", holidayRoutes);
app.route("/api/admin/upload", uploadRoutes);
app.route("/api/admin/orders", adminOrderRoutes);
app.route("/api/admin/faqs", faqRoutes);
app.route("/api/admin/dispatch-windows", adminDispatchWindowRoutes);
app.route("/api/admin/addons", addonRoutes);
app.route("/api/admin/order-settings", adminOrderSettingsRoutes);

// --- Client Routes (public, read-only) ---
app.route("/api/client", clientRoutes);

// --- Webhooks ---
app.route("/api/webhooks/razorpay", razorpayWebhookRoutes);

// --- 404 Fallback ---

app.notFound((c) => {
  return c.json(
    {
      success: false,
      message: `Route not found: ${c.req.method} ${c.req.path}`,
    },
    404,
  );
});

// --- Global Error Handler ---

app.onError((err, c) => {
  captureException(err, {
    tags: {
      method: c.req.method,
      path: c.req.path,
    },
    extra: {
      query: c.req.query(),
    },
    user: c.get("userId")
      ? { id: c.get("userId") }
      : c.get("adminId")
      ? { id: c.get("adminId") }
      : undefined,
  });

  console.error(`[Unhandled Error] ${c.req.method} ${c.req.path}:`, err);

  // Never leak internal hostnames, cluster URLs, credentials, or driver internals
  let message = "Internal server error";
  if (c.env.NODE_ENV === "development") {
    const isSensitive =
      /querySrv|mongodb|_mongodb|cluster0|atlas|password|secret|key/i.test(
        err.message || "",
      );
    message = isSensitive
      ? "Database or server connection error. Please check server logs."
      : err.message || "Internal server error";
  }

  return c.json({ success: false, message }, 500);
});

export default withSentry(
  (env: any) => ({
    dsn: env?.SENTRY_DSN,
    tracesSampleRate: 0.0,
  }),
  {
    fetch: app.fetch,
    async scheduled(_event: any, env: any, ctx: any) {
      if (ctx?.waitUntil) {
        ctx.waitUntil(
          (async () => {
            try {
              const { getDb } = await import("./lib/db");
              const { retryFailedRefunds } = await import("./lib/refund-retry");
              const { cleanupExpiredPendingOrders } = await import("./lib/order-cleanup");
              const { db, client } = await getDb(env.MONGODB_URI, env.MONGODB_DB_NAME);
              try {
                const [refundRes, cleanupRes] = await Promise.allSettled([
                  retryFailedRefunds(db, env),
                  cleanupExpiredPendingOrders(db),
                ]);
                console.log("[Scheduled Cron] Run completed:", {
                  refunds: refundRes.status === "fulfilled" ? refundRes.value : refundRes.reason,
                  cleanup: cleanupRes.status === "fulfilled" ? cleanupRes.value : cleanupRes.reason,
                });
              } finally {
                await client.close().catch(() => {});
              }
            } catch (err) {
              console.error("[Scheduled Cron] Error in cron maintenance jobs:", err);
            }
          })(),
        );
      }
    },
  },
);
