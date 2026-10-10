import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { generateId } from "../../lib/crypto";
import { createCategorySchema, updateCategorySchema } from "../../schemas";
import { formatZodErrors, slugify } from "../../utils";
import { authMiddleware } from "../../middleware/auth";
import { bumpConfigVersion } from "../../lib/config-version";
import type { CategoryDoc } from "../../types";

const categoryRoutes = new Hono<AppBindings>();

// All category routes require authentication
categoryRoutes.use("*", authMiddleware);

/**
 * GET /categories
 *
 * Lists all categories, ordered by displayOrder.
 */
categoryRoutes.get("/", async (c) => {
  try {
    const db = c.get("db");
    const categories = db.collection<CategoryDoc>(COLLECTIONS.CATEGORIES);

    const result = await categories
      .find({}, { projection: { _id: 0 } })
      .sort({ displayOrder: 1, name: 1 })
      .toArray();

    return c.json({ success: true, categories: result });
  } catch (error) {
    console.error("Get categories error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * GET /categories/:categoryId
 *
 * Returns a single category by ID.
 */
categoryRoutes.get("/:categoryId", async (c) => {
  try {
    const categoryId = c.req.param("categoryId");
    const db = c.get("db");
    const categories = db.collection<CategoryDoc>(COLLECTIONS.CATEGORIES);

    const category = await categories.findOne(
      { id: categoryId },
      { projection: { _id: 0 } },
    );

    if (!category) {
      return c.json({ success: false, message: "Category not found" }, 404);
    }

    return c.json({ success: true, category });
  } catch (error) {
    console.error("Get category by ID error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * POST /categories
 *
 * Creates a new category.
 */
categoryRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createCategorySchema.safeParse(body);

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

    const { name, displayOrder } = parsed.data;
    const slug = slugify(name);

    const db = c.get("db");
    const categories = db.collection<CategoryDoc>(COLLECTIONS.CATEGORIES);

    // Check for duplicate slug
    const existing = await categories.findOne({ slug });
    if (existing) {
      return c.json({ success: false, message: `Category "${name}" already exists` }, 409);
    }

    const now = new Date();
    const category: CategoryDoc = {
      id: generateId("cat"),
      name: name.trim(),
      slug,
      displayOrder,
      createdAt: now,
      updatedAt: now,
    };

    await categories.insertOne(category);
    await bumpConfigVersion(db).catch((e) =>
      console.error("Failed to bump config version on category creation:", e),
    );

    return c.json(
      {
        success: true,
        message: "Category created successfully",
        category: {
          id: category.id,
          name: category.name,
          slug: category.slug,
          displayOrder: category.displayOrder,
        },
      },
      201,
    );
  } catch (error) {
    console.error("Create category error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PATCH /categories/:categoryId
 *
 * Updates an existing category.
 */
categoryRoutes.patch("/:categoryId", async (c) => {
  try {
    const categoryId = c.req.param("categoryId");
    const body = await c.req.json();
    const parsed = updateCategorySchema.safeParse(body);

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
    const categories = db.collection<CategoryDoc>(COLLECTIONS.CATEGORIES);

    // Build update object
    const setFields: Record<string, unknown> = { updatedAt: new Date() };

    if (updates.name !== undefined) {
      const newSlug = slugify(updates.name);
      // Check slug uniqueness (exclude self)
      const existing = await categories.findOne({
        slug: newSlug,
        id: { $ne: categoryId },
      });
      if (existing) {
        return c.json({ success: false, message: `Category "${updates.name}" already exists` }, 409);
      }
      setFields.name = updates.name.trim();
      setFields.slug = newSlug;
    }

    if (updates.displayOrder !== undefined) {
      setFields.displayOrder = updates.displayOrder;
    }

    const result = await categories.findOneAndUpdate(
      { id: categoryId },
      { $set: setFields },
      { returnDocument: "after", projection: { _id: 0, createdAt: 0, updatedAt: 0 } },
    );

    if (!result) {
      return c.json({ success: false, message: "Category not found" }, 404);
    }

    // If name/slug changed, update all products referencing this category
    if (setFields.slug) {
      const products = db.collection(COLLECTIONS.PRODUCTS);
      await products.updateMany(
        { categoryId },
        { $set: { categorySlug: setFields.slug as string } },
      );
    }

    await bumpConfigVersion(db).catch((e) =>
      console.error("Failed to bump config version on category update:", e),
    );

    return c.json({
      success: true,
      message: "Category updated successfully",
      category: result,
    });
  } catch (error) {
    console.error("Update category error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * DELETE /categories/:categoryId
 *
 * Deletes a category. Fails if products still reference it.
 */
categoryRoutes.delete("/:categoryId", async (c) => {
  try {
    const categoryId = c.req.param("categoryId");
    const db = c.get("db");
    const categories = db.collection<CategoryDoc>(COLLECTIONS.CATEGORIES);
    const products = db.collection(COLLECTIONS.PRODUCTS);

    // Prevent deletion if products exist in this category
    const productCount = await products.countDocuments({ categoryId });
    if (productCount > 0) {
      return c.json(
        {
          success: false,
          message: `Cannot delete category: ${productCount} product(s) still assigned to it. Reassign them first.`,
        },
        400,
      );
    }

    const result = await categories.deleteOne({ id: categoryId });
    if (result.deletedCount === 0) {
      return c.json({ success: false, message: "Category not found" }, 404);
    }

    await bumpConfigVersion(db).catch((e) =>
      console.error("Failed to bump config version on category delete:", e),
    );

    return c.json({
      success: true,
      message: "Category deleted successfully",
    });
  } catch (error) {
    console.error("Delete category error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { categoryRoutes };
