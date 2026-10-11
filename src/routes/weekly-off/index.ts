import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { bumpConfigVersion } from "../../lib/config-version";
import { updateWeeklyOffSchema } from "../../schemas";
import { formatZodErrors } from "../../utils";
import { authMiddleware } from "../../middleware/auth";
import type { WeeklyOffDoc } from "../../types";

const weeklyOffRoutes = new Hono<AppBindings>();

// All routes require authentication
weeklyOffRoutes.use("*", authMiddleware);

/**
 * GET /weekly-off
 *
 * Returns the list of recurring weekly off days.
 */
weeklyOffRoutes.get("/", async (c) => {
  try {
    const db = c.get("db");
    const collection = db.collection<WeeklyOffDoc>(COLLECTIONS.WEEKLY_OFF);

    // Single document design -- only one record exists
    const doc = await collection.findOne({});

    return c.json({
      success: true,
      weeklyOff: doc?.days || ["monday"], // default: monday
    });
  } catch (error) {
    console.error("Get weekly off error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PUT /weekly-off
 *
 * Replaces the entire weekly off schedule.
 * Uses upsert -- creates if doesn't exist.
 */
weeklyOffRoutes.put("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = updateWeeklyOffSchema.safeParse(body);

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

    // Deduplicate days
    const uniqueDays = [...new Set(parsed.data.days)];

    const db = c.get("db");
    const collection = db.collection<WeeklyOffDoc>(COLLECTIONS.WEEKLY_OFF);

    await collection.updateOne(
      {},
      {
        $set: {
          days: uniqueDays,
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
      message: "Weekly off schedule updated successfully",
    });
  } catch (error) {
    console.error("Update weekly off error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { weeklyOffRoutes };
