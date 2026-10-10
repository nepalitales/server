import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { bumpConfigVersion } from "../../lib/config-version";
import {
  dayOfWeekSchema,
  updateDispatchWindowSchema,
  bulkUpdateDispatchWindowSchema,
} from "../../schemas";
import { formatZodErrors } from "../../utils";
import { authMiddleware } from "../../middleware/auth";
import {
  getTomorrowIstDate,
  getSlotUsageOverview,
} from "../../lib/dispatch-windows";
import type { DispatchWindowDoc, DayOfWeek, DispatchSlot } from "../../types";

const adminDispatchWindowRoutes = new Hono<AppBindings>();

// All admin dispatch window endpoints require admin authentication
adminDispatchWindowRoutes.use("*", authMiddleware);

const DAY_ORDER: DayOfWeek[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * GET /api/admin/dispatch-windows
 *
 * Returns all 7 days' dispatch windows and slot configurations.
 */
adminDispatchWindowRoutes.get("/", async (c) => {
  try {
    const db = c.get("db");
    const collection = db.collection<DispatchWindowDoc>(COLLECTIONS.DISPATCH_WINDOWS);

    const windows = await collection
      .find({}, { projection: { _id: 0 } })
      .toArray();

    const windowMap = new Map(windows.map((w) => [w.day, w]));
    const result = DAY_ORDER.map(
      (day) =>
        windowMap.get(day) || {
          day,
          enabled: false,
          slots: [],
        },
    );

    return c.json({ success: true, dispatchWindows: result });
  } catch (error) {
    console.error("Get dispatch windows error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * GET /api/admin/dispatch-windows/capacity
 *
 * Live slot utilization breakdown for any date (default: tomorrow in IST).
 */
adminDispatchWindowRoutes.get("/capacity", async (c) => {
  try {
    const db = c.get("db");
    const dateQuery = c.req.query("date");
    const tomorrow = getTomorrowIstDate();
    const targetDate = dateQuery || tomorrow.dateStr;

    const overview = await getSlotUsageOverview(db, targetDate);
    return c.json({ success: true, capacity: overview });
  } catch (error) {
    console.error("Get dispatch capacity overview error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PUT /api/admin/dispatch-windows/bulk
 *
 * Bulk updates dispatch windows for multiple selected days.
 */
adminDispatchWindowRoutes.put("/bulk", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = bulkUpdateDispatchWindowSchema.safeParse(body);

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

    const { days, enabled, slots } = parsed.data;

    // Validate slots don't overlap
    if (slots.length > 1) {
      const sorted = [...slots].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.start < sorted[i - 1]!.end) {
          return c.json(
            {
              success: false,
              message: `Slot conflict: ${sorted[i - 1]!.label} overlaps with ${sorted[i]!.label}`,
            },
            400,
          );
        }
      }
    }

    const db = c.get("db");
    const collection = db.collection<DispatchWindowDoc>(COLLECTIONS.DISPATCH_WINDOWS);
    const now = new Date();

    const operations = days.map((day) => ({
      updateOne: {
        filter: { day },
        update: {
          $set: {
            day,
            enabled,
            slots,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    }));

    await collection.bulkWrite(operations);
    await bumpConfigVersion(db);

    return c.json({
      success: true,
      message: `Dispatch windows updated for ${days.length} day(s)`,
    });
  } catch (error) {
    console.error("Bulk update dispatch windows error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PUT /api/admin/dispatch-windows/:day
 *
 * Updates dispatch window and slots for a specific day.
 */
adminDispatchWindowRoutes.put("/:day", async (c) => {
  try {
    const dayParam = c.req.param("day");
    const dayParsed = dayOfWeekSchema.safeParse(dayParam);

    if (!dayParsed.success) {
      return c.json({ success: false, message: "Invalid day of week" }, 400);
    }

    const day = dayParsed.data;
    const body = await c.req.json();
    const parsed = updateDispatchWindowSchema.safeParse(body);

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

    const { enabled, slots } = parsed.data;

    // Validate slots don't overlap
    if (slots.length > 1) {
      const sorted = [...slots].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.start < sorted[i - 1]!.end) {
          return c.json(
            {
              success: false,
              message: `Slot conflict: ${sorted[i - 1]!.label} overlaps with ${sorted[i]!.label}`,
            },
            400,
          );
        }
      }
    }

    const db = c.get("db");
    const collection = db.collection<DispatchWindowDoc>(COLLECTIONS.DISPATCH_WINDOWS);
    const now = new Date();

    await collection.updateOne(
      { day },
      {
        $set: {
          day,
          enabled,
          slots,
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    await bumpConfigVersion(db);

    return c.json({
      success: true,
      message: `Dispatch window for ${day} updated successfully`,
    });
  } catch (error) {
    console.error("Update dispatch window error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { adminDispatchWindowRoutes };
