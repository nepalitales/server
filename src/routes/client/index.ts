import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { getConfigVersion } from "../../lib/config-version";
import { checkOrderWindow } from "../../lib/order-window";
import { getAvailableDispatchSlots } from "../../lib/dispatch-windows";
import { clientAuthRoutes } from "./auth";
import { clientAddressRoutes } from "./address";
import { clientOrderRoutes } from "./orders";
import {
  getCachedAddons,
  matchEdgeAddonsCache,
  putEdgeAddonsCache,
} from "../../lib/addons-cache";
import { getOrderSettings, publicOrderSettings } from "../../lib/order-settings";
import type {
  ProductDoc,
  CategoryDoc,
  OrderWindowDoc,
  WeeklyOffDoc,
  HolidayDoc,
  DayOfWeek,
  FaqDoc,
} from "../../types";

const clientRoutes = new Hono<AppBindings>();

// ─── Customer Authentication (WhatsApp OTP) ──────────────────────
clientRoutes.route("/auth", clientAuthRoutes);

// ─── Customer Delivery Addresses (Borzo Compatible) ─────────────
clientRoutes.route("/addresses", clientAddressRoutes);

// ─── Customer Orders (Razorpay & Borzo Integrated) ───────────────
clientRoutes.route("/orders", clientOrderRoutes);

// ─── Products ────────────────────────────────────────────────────

/**
 * GET /api/client/products
 *
 * Returns all available products, optionally filtered by category slug.
 * Only returns isAvailable=true products.
 */
clientRoutes.get("/products", async (c) => {
  try {
    const categorySlug = c.req.query("category");
    const foodType = c.req.query("type");
    const search = c.req.query("search")?.trim();
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "6", 10)));
    const skip = (page - 1) * limit;

    const db = c.get("db");
    const products = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);

    // Only show available products to clients
    const filter: Record<string, unknown> = { isAvailable: true };
    if (categorySlug && categorySlug !== "all") {
      filter.categorySlug = categorySlug;
    }
    if (foodType && (foodType === "veg" || foodType === "non-veg")) {
      filter.type = foodType;
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      products
        .find(filter, { projection: { _id: 0, imagePublicId: 0, isAvailable: 0 } })
        .sort({ categorySlug: 1, name: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      products.countDocuments(filter),
    ]);

    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({
      success: true,
      products: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Client get products error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * GET /api/client/products/:productId
 *
 * Returns a single available product by ID.
 */
clientRoutes.get("/products/:productId", async (c) => {
  try {
    const productId = c.req.param("productId");
    const db = c.get("db");
    const products = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);

    const product = await products.findOne(
      { id: productId, isAvailable: true },
      { projection: { _id: 0, imagePublicId: 0, isAvailable: 0 } },
    );

    if (!product) {
      return c.json({ success: false, message: "Product not found" }, 404);
    }

    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({ success: true, product });
  } catch (error) {
    console.error("Client get product error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── Categories ───────────────────────────────────────────────────

/**
 * GET /api/client/categories
 *
 * Returns all categories with their products grouped inside.
 * This is the primary endpoint for rendering the full menu.
 */
clientRoutes.get("/categories", async (c) => {
  try {
    const db = c.get("db");
    const categories = db.collection<CategoryDoc>(COLLECTIONS.CATEGORIES);
    const products = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);

    const [cats, prods] = await Promise.all([
      categories
        .find({}, { projection: { _id: 0, createdAt: 0, updatedAt: 0 } })
        .sort({ displayOrder: 1, name: 1 })
        .toArray(),
      products
        .find({ isAvailable: true }, { projection: { _id: 0, imagePublicId: 0, isAvailable: 0 } })
        .sort({ name: 1 })
        .toArray(),
    ]);

    // Group products under each category
    const prodsByCategory = new Map<string, typeof prods>();
    for (const prod of prods) {
      const existing = prodsByCategory.get(prod.categoryId) ?? [];
      existing.push(prod);
      prodsByCategory.set(prod.categoryId, existing);
    }

    const result = cats.map((cat) => ({
      ...cat,
      products: prodsByCategory.get(cat.id) ?? [],
    }));

    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({ success: true, categories: result });
  } catch (error) {
    console.error("Client get categories error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── Order Windows ────────────────────────────────────────────────

/**
 * GET /api/client/order-windows
 *
 * Returns all 7 days' order windows.
 * Used by clients to know when ordering is open.
 */
clientRoutes.get("/order-windows", async (c) => {
  try {
    const db = c.get("db");
    const collection = db.collection<OrderWindowDoc>(COLLECTIONS.ORDER_WINDOWS);

    const windows = await collection
      .find({}, { projection: { _id: 0 } })
      .toArray();

    const dayOrder: DayOfWeek[] = [
      "sunday", "monday", "tuesday", "wednesday",
      "thursday", "friday", "saturday",
    ];

    const windowMap = new Map(windows.map((w) => [w.day, w]));
    const result = dayOrder.map((day) => windowMap.get(day) || {
      day,
      enabled: false,
      windows: [],
    });

    c.header("Cache-Control", "public, max-age=30, s-maxage=120, stale-while-revalidate=300");
    return c.json({ success: true, orderWindows: result });
  } catch (error) {
    console.error("Client get order windows error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * GET /api/client/order-window-status
 *
 * Public endpoint for clients to instantly check if the ordering window is open or closed,
 * and when the active window starts/ends.
 */
clientRoutes.get("/order-window-status", async (c) => {
  try {
    const db = c.get("db");
    // Strictly evaluate real-life live order window schedule without dev bypass
    const windowCheck = await checkOrderWindow(db, false);
    c.header("Cache-Control", "public, max-age=10, s-maxage=30, stale-while-revalidate=60");
    return c.json({ success: true, ...windowCheck });
  } catch (error) {
    console.error("Client get order window status error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── Dispatch Windows & Slots ────────────────────────────────────

/**
 * GET /api/client/dispatch-slots
 *
 * Real-time endpoint returning live dispatch slots and available capacity.
 * Defaults to tomorrow's date in IST (pre-order model).
 */
clientRoutes.get("/dispatch-slots", async (c) => {
  try {
    const db = c.get("db");
    const dateQuery = c.req.query("date");
    const availability = await getAvailableDispatchSlots(db, dateQuery);
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({ success: true, ...availability });
  } catch (error) {
    console.error("Client get dispatch slots error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── Weekly Off ───────────────────────────────────────────────────

/**
 * GET /api/client/weekly-off
 *
 * Returns the recurring weekly off days.
 */
clientRoutes.get("/weekly-off", async (c) => {
  try {
    const db = c.get("db");
    const collection = db.collection<WeeklyOffDoc>(COLLECTIONS.WEEKLY_OFF);

    const doc = await collection.findOne({});
    c.header("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return c.json({
      success: true,
      weeklyOff: doc?.days ?? ["monday"],
    });
  } catch (error) {
    console.error("Client get weekly off error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── Holidays ─────────────────────────────────────────────────────

/**
 * GET /api/client/holidays
 *
 * Returns all upcoming holidays (today and future only).
 */
clientRoutes.get("/holidays", async (c) => {
  try {
    const db = c.get("db");
    const holidays = db.collection<HolidayDoc>(COLLECTIONS.HOLIDAYS);

    // Only return today onwards
    const today = new Date().toISOString().slice(0, 10);

    const result = await holidays
      .find(
        { date: { $gte: today } },
        { projection: { _id: 0, createdAt: 0, updatedAt: 0 } },
      )
      .sort({ date: 1 })
      .toArray();

    c.header("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return c.json({ success: true, holidays: result });
  } catch (error) {
    console.error("Client get holidays error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── Config Snapshot ──────────────────────────────────────────────

/**
 * GET /api/client/config
 *
 * Single endpoint that returns everything the client needs to boot:
 * order windows, weekly off, holidays, and the current config version.
 * Clients fetch this once on load; SSE notifies them when to re-fetch.
 */
clientRoutes.get("/config", async (c) => {
  try {
    const db = c.get("db");

    const [orderWindows, weeklyOffDoc, holidays, configVersion] = await Promise.all([
      db.collection<OrderWindowDoc>(COLLECTIONS.ORDER_WINDOWS)
        .find({}, { projection: { _id: 0 } })
        .toArray(),
      db.collection<WeeklyOffDoc>(COLLECTIONS.WEEKLY_OFF).findOne({}),
      db.collection<HolidayDoc>(COLLECTIONS.HOLIDAYS)
        .find(
          { date: { $gte: new Date().toISOString().slice(0, 10) } },
          { projection: { _id: 0, createdAt: 0, updatedAt: 0 } },
        )
        .sort({ date: 1 })
        .toArray(),
      getConfigVersion(db),
    ]);

    const dayOrder: DayOfWeek[] = [
      "sunday", "monday", "tuesday", "wednesday",
      "thursday", "friday", "saturday",
    ];

    const windowMap = new Map(orderWindows.map((w) => [w.day, w]));
    const normalizedWindows = dayOrder.map((day) => windowMap.get(day) || {
      day,
      enabled: false,
      windows: [],
    });

    c.header("Cache-Control", "public, max-age=30, s-maxage=120, stale-while-revalidate=300");
    return c.json({
      success: true,
      configVersion,
      orderWindows: normalizedWindows,
      weeklyOff: weeklyOffDoc?.days ?? ["monday"],
      holidays,
    });
  } catch (error) {
    console.error("Client get config error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── Order type (pickup / delivery) ──────────────────────────────

/**
 * GET /api/client/order-settings
 *
 * Public checkout config: which order types are enabled, delivery fee,
 * and pickup instructions. Cached at the HTTP layer.
 */
clientRoutes.get("/order-settings", async (c) => {
  try {
    const db = c.get("db");
    const settings = await getOrderSettings(db);
    c.header("Cache-Control", "public, max-age=30, s-maxage=120, stale-while-revalidate=300");
    return c.json({
      success: true,
      settings: publicOrderSettings(settings),
    });
  } catch (error) {
    console.error("Client get order settings error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── Add-ons ─────────────────────────────────────────────────────

/**
 * GET /api/client/addons
 *
 * Public catalog of available add-ons. Served from isolate memory
 * and the Cloudflare Cache API so repeated menu loads skip MongoDB.
 */
clientRoutes.get("/addons", async (c) => {
  try {
    const db = c.get("db");
    const addons = await getCachedAddons(db, { availableOnly: true });

    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({ success: true, addons });
  } catch (error) {
    console.error("Client get addons error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── Frequently Asked Questions (FAQ) ────────────────────────────

/**
 * GET /api/client/faqs
 *
 * Returns all active FAQs, ordered by displayOrder.
 * Optionally filtered by category query param.
 */
clientRoutes.get("/faqs", async (c) => {
  try {
    const category = c.req.query("category");
    const db = c.get("db");
    const faqs = db.collection<FaqDoc>(COLLECTIONS.FAQS);

    const filter: Record<string, unknown> = { isActive: true };
    if (category) {
      filter.category = category;
    }

    const items = await faqs
      .find(filter, { projection: { _id: 0, isActive: 0 } })
      .sort({ displayOrder: 1, createdAt: 1 })
      .toArray();

    c.header("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return c.json({
      success: true,
      faqs: items,
    });
  } catch (error) {
    console.error("Client get faqs error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── SSE — Real-time config updates ──────────────────────────────

/**
 * GET /api/client/events
 *
 * Server-Sent Events stream for real-time config change notifications.
 *
 * How it works (stateless Worker-friendly):
 * 1. Client connects and sends its current config version via ?version=<v>.
 * 2. Worker opens a streaming Response and polls MongoDB every 5s.
 * 3. When the version in DB differs from the client's known version, it
 *    sends a "config_changed" event — client re-fetches /api/client/config.
 * 4. Heartbeats keep the connection alive between polls.
 * 5. After ~25s the stream closes gracefully. The browser's EventSource
 *    automatically reconnects (with exponential backoff).
 *
 * Products/categories are large; clients should poll /api/client/categories
 * on initial load (and optionally on a slower poll interval, e.g. 60s).
 */
clientRoutes.get("/events", async (c) => {
  const clientVersion = c.req.query("version") ?? "0";
  const db = c.get("db");
  const client = c.get("dbClient");

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (event: string, data: Record<string, unknown>) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    return writer.write(encoder.encode(payload));
  };

  // Run the polling loop asynchronously so we can return the Response immediately
  const streamPromise = (async () => {
    try {
      await send("connected", { version: clientVersion });

      let knownVersion = clientVersion;
      const pollIntervalMs = 5_000;
      // Stay under Cloudflare Workers' wall-clock limit
      const maxRunMs = 25_000;
      const startedAt = Date.now();

      while (Date.now() - startedAt < maxRunMs) {
        await new Promise<void>((r) => setTimeout(r, pollIntervalMs));

        const currentVersion = await getConfigVersion(db);

        if (currentVersion !== knownVersion) {
          knownVersion = currentVersion;
          await send("config_changed", { version: currentVersion });
        } else {
          // Heartbeat to detect dead connections
          await send("heartbeat", { ts: Date.now() });
        }
      }

      // Graceful close — EventSource reconnects automatically
      await send("reconnect", { reason: "stream_timeout" });
    } catch {
      // Client disconnected — swallow
    } finally {
      await writer.close().catch(() => {});
      await client?.close().catch(() => {});
    }
  })();

  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(streamPromise);
  }

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable Nginx/Cloudflare proxy buffering
    },
  });
});

export { clientRoutes };
