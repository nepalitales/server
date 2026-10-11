import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { authMiddleware } from "../../middleware/auth";
import { bumpConfigVersion } from "../../lib/config-version";
import {
  getOrderSettings,
  ORDER_SETTINGS_DOC_ID,
  publicOrderSettings,
} from "../../lib/order-settings";
import { updateOrderSettingsSchema } from "../../schemas";
import { formatZodErrors } from "../../utils";
import type { OrderSettingsDoc } from "../../types";

const adminOrderSettingsRoutes = new Hono<AppBindings>();

adminOrderSettingsRoutes.use("*", authMiddleware);

/**
 * GET /api/admin/order-settings
 */
adminOrderSettingsRoutes.get("/", async (c) => {
  try {
    const db = c.get("db");
    const settings = await getOrderSettings(db);
    return c.json({
      success: true,
      settings: publicOrderSettings(settings),
    });
  } catch (error) {
    console.error("Get order settings error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PUT /api/admin/order-settings
 */
adminOrderSettingsRoutes.put("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = updateOrderSettingsSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid order settings",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const db = c.get("db");
    const now = new Date();
    await db.collection<OrderSettingsDoc>(COLLECTIONS.ORDER_SETTINGS).updateOne(
      { docId: ORDER_SETTINGS_DOC_ID },
      {
        $set: {
          docId: ORDER_SETTINGS_DOC_ID,
          pickupEnabled: parsed.data.pickupEnabled,
          deliveryEnabled: parsed.data.deliveryEnabled,
          deliveryFee: parsed.data.deliveryFee,
          pickupInstructions: parsed.data.pickupInstructions,
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    await bumpConfigVersion(db, c.env);
    const settings = await getOrderSettings(db);

    return c.json({
      success: true,
      message: "Order type settings updated",
      settings: publicOrderSettings(settings),
    });
  } catch (error) {
    console.error("Update order settings error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { adminOrderSettingsRoutes };
