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
import { matchEdgeAddonsCache } from "./lib/addons-cache";

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

// CORS -- allow admin frontend origin
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.CORS_ORIGIN;
      if (allowed === "*") return origin;
      return allowed.split(",").includes(origin) ? origin : "";
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    maxAge: 86400,
  }),
);

// Serve cached public add-ons without opening MongoDB
app.use("/api/client/addons", async (c, next) => {
  if (c.req.method !== "GET") {
    await next();
    return;
  }
  const cached = await matchEdgeAddonsCache();
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: cached.headers,
    });
  }
  await next();
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
    tracesSampleRate: env?.NODE_ENV === "production" ? 0.2 : 1.0,
  }),
  app,
);
