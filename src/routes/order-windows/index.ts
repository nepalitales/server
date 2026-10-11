import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { bumpConfigVersion } from "../../lib/config-version";
import { dayOfWeekSchema, updateOrderWindowSchema, bulkUpdateOrderWindowSchema } from "../../schemas";
import { formatZodErrors } from "../../utils";
import { authMiddleware } from "../../middleware/auth";
import type { OrderWindowDoc, DayOfWeek } from "../../types";

const orderWindowRoutes = new Hono<AppBindings>();

// All routes require authentication
orderWindowRoutes.use("*", authMiddleware);

/**
 * GET /order-windows
 *
 * Returns all 7 days' order windows.
 */
orderWindowRoutes.get("/", async (c) => {
  try {
    const db = c.get("db");
    const collection = db.collection<OrderWindowDoc>(COLLECTIONS.ORDER_WINDOWS);

    const windows = await collection
      .find({}, { projection: { _id: 0 } })
      .toArray();

    // Ensure all 7 days are returned, even if not configured yet
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

    return c.json({ success: true, orderWindows: result });
  } catch (error) {
    console.error("Get order windows error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PUT /order-windows/bulk
 *
 * Bulk updates order windows for specified days.
 */
orderWindowRoutes.put("/bulk", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = bulkUpdateOrderWindowSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid request data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const { days, enabled, windows } = parsed.data;

    // Validate windows don't overlap
    if (windows.length > 1) {
      const sorted = [...windows].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.start < sorted[i - 1]!.end) {
          return c.json({ success: false, message: "Time windows must not overlap" }, 400);
        }
      }
    }

    const db = c.get("db");
    const collection = db.collection<OrderWindowDoc>(COLLECTIONS.ORDER_WINDOWS);
    const now = new Date();

    const operations = days.map((day) => ({
      updateOne: {
        filter: { day },
        update: {
          $set: {
            day,
            enabled,
            windows,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    }));

    await collection.bulkWrite(operations);

    // Notify SSE clients that config has changed
    await bumpConfigVersion(db, c.env).catch((e) =>
      console.error("Failed to bump config version:", e),
    );

    return c.json({
      success: true,
      message: `Order windows updated for ${days.length} day(s)`,
    });
  } catch (error) {
    console.error("Bulk update order windows error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PUT /order-windows/:day
 *
 * Updates the order windows for a specific day.
 * Uses upsert -- creates the doc if it doesn't exist.
 */
orderWindowRoutes.put("/:day", async (c) => {
  try {
    const dayParam = c.req.param("day");
    const dayParsed = dayOfWeekSchema.safeParse(dayParam);

    if (!dayParsed.success) {
      return c.json(
        {
          success: false,
          message: `Invalid day: "${dayParam}". Must be one of: sunday, monday, tuesday, wednesday, thursday, friday, saturday`,
        },
        400,
      );
    }

    const body = await c.req.json();
    const parsed = updateOrderWindowSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid request data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const { enabled, windows } = parsed.data;

    // Validate windows don't overlap
    if (windows.length > 1) {
      const sorted = [...windows].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.start < sorted[i - 1]!.end) {
          return c.json({ success: false, message: "Time windows must not overlap" }, 400);
        }
      }
    }

    const db = c.get("db");
    const collection = db.collection<OrderWindowDoc>(COLLECTIONS.ORDER_WINDOWS);

    await collection.updateOne(
      { day: dayParsed.data },
      {
        $set: {
          day: dayParsed.data,
          enabled,
          windows,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

    // Notify SSE clients that config has changed
    await bumpConfigVersion(db, c.env).catch((e) =>
      console.error("Failed to bump config version:", e),
    );

    return c.json({
      success: true,
      message: "Order window updated successfully",
    });
  } catch (error) {
    console.error("Update order window error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { orderWindowRoutes };
