import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { generateId } from "../../lib/crypto";
import { uploadToCloudinary, deleteFromCloudinary } from "../../lib/cloudinary";
import { createAddonSchema, updateAddonSchema } from "../../schemas";
import { formatZodErrors } from "../../utils";
import { authMiddleware } from "../../middleware/auth";
import { bumpConfigVersion } from "../../lib/config-version";
import { ensureAddonIndexes, getCachedAddons, invalidateAddonsCache } from "../../lib/addons-cache";
import type { AddonDoc } from "../../types";

const addonRoutes = new Hono<AppBindings>();

addonRoutes.use("*", authMiddleware);

function cloudinaryConfig(c: { env: AppBindings["Bindings"] }) {
  const cloudName = c.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = c.env.CLOUDINARY_API_KEY;
  const apiSecret = c.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}

/**
 * GET /api/admin/addons
 */
addonRoutes.get("/", async (c) => {
  try {
    const db = c.get("db");
    const addons = await getCachedAddons(db, { availableOnly: false });
    return c.json({ success: true, addons });
  } catch (error) {
    console.error("Get addons error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * GET /api/admin/addons/:addonId
 */
addonRoutes.get("/:addonId", async (c) => {
  try {
    const addonId = c.req.param("addonId");
    const db = c.get("db");
    const addon = await db.collection<AddonDoc>(COLLECTIONS.ADDONS).findOne(
      { id: addonId },
      { projection: { _id: 0, imagePublicId: 0 } },
    );

    if (!addon) {
      return c.json({ success: false, message: "Add-on not found" }, 404);
    }

    return c.json({ success: true, addon });
  } catch (error) {
    console.error("Get addon error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * POST /api/admin/addons
 */
addonRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createAddonSchema.safeParse(body);

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

    const { name, price, image, isAvailable, displayOrder } = parsed.data;
    const db = c.get("db");
    await ensureAddonIndexes(db);
    const addons = db.collection<AddonDoc>(COLLECTIONS.ADDONS);

    let imageUrl = image;
    let imagePublicId: string | undefined;
    const cloudinary = cloudinaryConfig(c);

    if (image.startsWith("data:") && cloudinary) {
      const result = await uploadToCloudinary(image, "addons", cloudinary);
      imageUrl = result.secure_url;
      imagePublicId = result.public_id;
    }

    let orderToSet = displayOrder ?? 0;
    if (!orderToSet) {
      const last = await addons
        .find({}, { projection: { displayOrder: 1 } })
        .sort({ displayOrder: -1 })
        .limit(1)
        .toArray();
      orderToSet = last[0] ? (last[0].displayOrder || 0) + 1 : 1;
    }

    const now = new Date();
    const addon: AddonDoc = {
      id: generateId("addon"),
      name: name.trim(),
      price,
      image: imageUrl,
      imagePublicId,
      isAvailable,
      displayOrder: orderToSet,
      createdAt: now,
      updatedAt: now,
    };

    await addons.insertOne(addon);
    invalidateAddonsCache();
    await bumpConfigVersion(db);

    return c.json(
      {
        success: true,
        message: "Add-on created successfully",
        addon: {
          id: addon.id,
          name: addon.name,
          price: addon.price,
          image: addon.image,
          isAvailable: addon.isAvailable,
          displayOrder: addon.displayOrder,
          createdAt: addon.createdAt,
          updatedAt: addon.updatedAt,
        },
      },
      201,
    );
  } catch (error) {
    console.error("Create addon error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PATCH /api/admin/addons/:addonId
 */
addonRoutes.patch("/:addonId", async (c) => {
  try {
    const addonId = c.req.param("addonId");
    const body = await c.req.json();
    const parsed = updateAddonSchema.safeParse(body);

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
    const addons = db.collection<AddonDoc>(COLLECTIONS.ADDONS);
    const existing = await addons.findOne({ id: addonId });

    if (!existing) {
      return c.json({ success: false, message: "Add-on not found" }, 404);
    }

    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) setFields.name = updates.name.trim();
    if (updates.price !== undefined) setFields.price = updates.price;
    if (updates.isAvailable !== undefined) setFields.isAvailable = updates.isAvailable;
    if (updates.displayOrder !== undefined) setFields.displayOrder = updates.displayOrder;

    let oldImagePublicId: string | undefined;
    const cloudinary = cloudinaryConfig(c);

    if (updates.image !== undefined) {
      if (updates.image.startsWith("data:") && cloudinary) {
        const result = await uploadToCloudinary(updates.image, "addons", cloudinary);
        setFields.image = result.secure_url;
        setFields.imagePublicId = result.public_id;
        oldImagePublicId = existing.imagePublicId;
      } else {
        setFields.image = updates.image;
      }
    }

    const result = await addons.findOneAndUpdate(
      { id: addonId },
      { $set: setFields },
      { returnDocument: "after", projection: { _id: 0, imagePublicId: 0 } },
    );

    if (!result) {
      return c.json({ success: false, message: "Add-on not found" }, 404);
    }

    if (oldImagePublicId && cloudinary) {
      try {
        await deleteFromCloudinary(oldImagePublicId, cloudinary);
      } catch (err) {
        console.error("Failed to delete old Cloudinary add-on image:", err);
      }
    }

    invalidateAddonsCache();
    await bumpConfigVersion(db);

    return c.json({
      success: true,
      message: "Add-on updated successfully",
      addon: result,
    });
  } catch (error) {
    console.error("Update addon error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * DELETE /api/admin/addons/:addonId
 */
addonRoutes.delete("/:addonId", async (c) => {
  try {
    const addonId = c.req.param("addonId");
    const db = c.get("db");
    const addons = db.collection<AddonDoc>(COLLECTIONS.ADDONS);
    const addon = await addons.findOne({ id: addonId });

    if (!addon) {
      return c.json({ success: false, message: "Add-on not found" }, 404);
    }

    const cloudinary = cloudinaryConfig(c);
    if (addon.imagePublicId && cloudinary) {
      try {
        await deleteFromCloudinary(addon.imagePublicId, cloudinary);
      } catch (err) {
        console.error("Cloudinary add-on image delete error:", err);
      }
    }

    await addons.deleteOne({ id: addonId });
    invalidateAddonsCache();
    await bumpConfigVersion(db);

    return c.json({
      success: true,
      message: "Add-on deleted successfully",
    });
  } catch (error) {
    console.error("Delete addon error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { addonRoutes };
