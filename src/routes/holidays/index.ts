import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { generateId } from "../../lib/crypto";
import { bumpConfigVersion } from "../../lib/config-version";
import { createHolidaySchema, updateHolidaySchema } from "../../schemas";
import { formatZodErrors } from "../../utils";
import { authMiddleware } from "../../middleware/auth";
import type { HolidayDoc } from "../../types";

const holidayRoutes = new Hono<AppBindings>();

// All routes require authentication
holidayRoutes.use("*", authMiddleware);

/**
 * GET /holidays
 *
 * Returns all holidays, sorted by date ascending.
 */
holidayRoutes.get("/", async (c) => {
  try {
    const db = c.get("db");
    const holidays = db.collection<HolidayDoc>(COLLECTIONS.HOLIDAYS);

    const result = await holidays
      .find({}, { projection: { _id: 0 } })
      .sort({ date: 1 })
      .toArray();

    return c.json({ success: true, holidays: result });
  } catch (error) {
    console.error("Get holidays error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * POST /holidays
 *
 * Adds a new holiday/temporary closing date.
 */
holidayRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createHolidaySchema.safeParse(body);

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

    const { date, reason } = parsed.data;

    const db = c.get("db");
    const holidays = db.collection<HolidayDoc>(COLLECTIONS.HOLIDAYS);

    // Check for duplicate date
    const existing = await holidays.findOne({ date });
    if (existing) {
      return c.json({ success: false, message: `A holiday is already set for ${date}` }, 409);
    }

    const now = new Date();
    const holiday: HolidayDoc = {
      id: generateId("holiday"),
      date,
      reason: reason.trim(),
      createdAt: now,
      updatedAt: now,
    };

    await holidays.insertOne(holiday);

    // Notify SSE clients that config has changed
    await bumpConfigVersion(db).catch((e) =>
      console.error("Failed to bump config version:", e),
    );

    return c.json(
      {
        success: true,
        message: "Holiday added successfully",
        holiday: {
          id: holiday.id,
          date: holiday.date,
          reason: holiday.reason,
        },
      },
      201,
    );
  } catch (error) {
    console.error("Add holiday error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PATCH /holidays/:holidayId
 *
 * Updates an existing holiday.
 */
holidayRoutes.patch("/:holidayId", async (c) => {
  try {
    const holidayId = c.req.param("holidayId");
    const body = await c.req.json();
    const parsed = updateHolidaySchema.safeParse(body);

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

    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      return c.json({ success: false, message: "No fields to update" }, 400);
    }

    const db = c.get("db");
    const holidays = db.collection<HolidayDoc>(COLLECTIONS.HOLIDAYS);

    const setFields: Record<string, unknown> = { updatedAt: new Date() };

    if (updates.date !== undefined) {
      // Check for duplicate date (exclude self)
      const existing = await holidays.findOne({
        date: updates.date,
        id: { $ne: holidayId },
      });
      if (existing) {
        return c.json({ success: false, message: `A holiday is already set for ${updates.date}` }, 409);
      }
      setFields.date = updates.date;
    }

    if (updates.reason !== undefined) {
      setFields.reason = updates.reason.trim();
    }

    const result = await holidays.findOneAndUpdate(
      { id: holidayId },
      { $set: setFields },
      { returnDocument: "after", projection: { _id: 0, createdAt: 0, updatedAt: 0 } },
    );

    if (!result) {
      return c.json({ success: false, message: "Holiday not found" }, 404);
    }

    // Notify SSE clients that config has changed
    await bumpConfigVersion(db).catch((e) =>
      console.error("Failed to bump config version:", e),
    );

    return c.json({
      success: true,
      message: "Holiday updated successfully",
      holiday: result,
    });
  } catch (error) {
    console.error("Update holiday error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * DELETE /holidays/:holidayId
 *
 * Deletes a holiday.
 */
holidayRoutes.delete("/:holidayId", async (c) => {
  try {
    const holidayId = c.req.param("holidayId");
    const db = c.get("db");
    const holidays = db.collection<HolidayDoc>(COLLECTIONS.HOLIDAYS);

    const result = await holidays.deleteOne({ id: holidayId });
    if (result.deletedCount === 0) {
      return c.json({ success: false, message: "Holiday not found" }, 404);
    }

    // Notify SSE clients that config has changed
    await bumpConfigVersion(db).catch((e) =>
      console.error("Failed to bump config version:", e),
    );

    return c.json({
      success: true,
      message: "Holiday deleted successfully",
    });
  } catch (error) {
    console.error("Delete holiday error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { holidayRoutes };
