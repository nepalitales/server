import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { generateId } from "../../lib/crypto";
import { uploadToCloudinary, deleteFromCloudinary } from "../../lib/cloudinary";
import { createProductSchema, updateProductSchema } from "../../schemas";
import { formatZodErrors } from "../../utils";
import { authMiddleware } from "../../middleware/auth";
import { bumpConfigVersion } from "../../lib/config-version";
import type { ProductDoc, CategoryDoc } from "../../types";

const productRoutes = new Hono<AppBindings>();

// All product routes require authentication
productRoutes.use("*", authMiddleware);

/**
 * GET /products
 *
 * Lists all products, optionally filtered by category.
 * Supports pagination for large menus.
 */
productRoutes.get("/", async (c) => {
  try {
    const categoryId = c.req.query("categoryId");
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
    const skip = (page - 1) * limit;

    const db = c.get("db");
    const products = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);

    const filter: Record<string, unknown> = {};
    if (categoryId) {
      filter.categoryId = categoryId;
    }

    const [items, total] = await Promise.all([
      products
        .find(filter, { projection: { _id: 0, imagePublicId: 0 } })
        .sort({ categorySlug: 1, name: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      products.countDocuments(filter),
    ]);

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
    console.error("Get products error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * GET /products/:productId
 *
 * Returns a single product by ID.
 */
productRoutes.get("/:productId", async (c) => {
  try {
    const productId = c.req.param("productId");
    const db = c.get("db");
    const products = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);

    const product = await products.findOne(
      { id: productId },
      { projection: { _id: 0, imagePublicId: 0 } },
    );

    if (!product) {
      return c.json({ success: false, message: "Product not found" }, 404);
    }

    return c.json({ success: true, product });
  } catch (error) {
    console.error("Get product error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * POST /products
 *
 * Creates a new product.
 * Image can be a URL or base64 data (uploaded to Cloudinary).
 */
productRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createProductSchema.safeParse(body);

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

    const { name, description, price, image, categoryId, type, quantity, isAvailable } = parsed.data;

    const db = c.get("db");
    const categories = db.collection<CategoryDoc>(COLLECTIONS.CATEGORIES);
    const products = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);

    // Validate category exists
    const category = await categories.findOne({ id: categoryId });
    if (!category) {
      return c.json(
        {
          success: false,
          message: "Invalid request data",
          errors: { categoryId: "Category not found" },
        },
        400,
      );
    }

    // Handle image: if base64, upload to Cloudinary
    let imageUrl = image;
    let imagePublicId: string | undefined;

    if (image.startsWith("data:") && c.env.CLOUDINARY_CLOUD_NAME && c.env.CLOUDINARY_API_KEY && c.env.CLOUDINARY_API_SECRET) {
      const result = await uploadToCloudinary(image, "products", {
        cloudName: c.env.CLOUDINARY_CLOUD_NAME,
        apiKey: c.env.CLOUDINARY_API_KEY,
        apiSecret: c.env.CLOUDINARY_API_SECRET,
      });
      imageUrl = result.secure_url;
      imagePublicId = result.public_id;
    }

    const now = new Date();
    const product: ProductDoc = {
      id: generateId("prod"),
      name: name.trim(),
      description: description.trim(),
      price,
      image: imageUrl,
      imagePublicId,
      categoryId,
      categorySlug: category.slug,
      type: type || "veg",
      quantity: quantity?.trim() || undefined,
      isAvailable,
      createdAt: now,
      updatedAt: now,
    };

    await products.insertOne(product);
    await bumpConfigVersion(db).catch((e) =>
      console.error("Failed to bump config version on product creation:", e),
    );

    return c.json(
      {
        success: true,
        message: "Product created successfully",
        product: {
          id: product.id,
          name: product.name,
          price: product.price,
          isAvailable: product.isAvailable,
        },
      },
      201,
    );
  } catch (error) {
    console.error("Create product error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PATCH /products/:productId
 *
 * Updates an existing product. Only changed fields need to be sent.
 */
productRoutes.patch("/:productId", async (c) => {
  try {
    const productId = c.req.param("productId");
    const body = await c.req.json();
    const parsed = updateProductSchema.safeParse(body);

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
    const products = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);

    // Fetch existing product (needed to get old imagePublicId for cleanup)
    const existingProduct = await products.findOne({ id: productId });
    if (!existingProduct) {
      return c.json({ success: false, message: "Product not found" }, 404);
    }

    const setFields: Record<string, unknown> = { updatedAt: new Date() };

    if (updates.name !== undefined) setFields.name = updates.name.trim();
    if (updates.description !== undefined) setFields.description = updates.description.trim();
    if (updates.price !== undefined) setFields.price = updates.price;
    if (updates.isAvailable !== undefined) setFields.isAvailable = updates.isAvailable;
    if (updates.type !== undefined) setFields.type = updates.type;
    if (updates.quantity !== undefined) setFields.quantity = updates.quantity.trim() || undefined;

    // If categoryId changed, validate and update slug
    if (updates.categoryId !== undefined) {
      const categories = db.collection<CategoryDoc>(COLLECTIONS.CATEGORIES);
      const category = await categories.findOne({ id: updates.categoryId });
      if (!category) {
        return c.json(
          {
            success: false,
            message: "Invalid request data",
            errors: { categoryId: "Category not found" },
          },
          400,
        );
      }
      setFields.categoryId = updates.categoryId;
      setFields.categorySlug = category.slug;
    }

    // Handle image update
    let oldImagePublicId: string | undefined;

    if (updates.image !== undefined) {
      if (updates.image.startsWith("data:") && c.env.CLOUDINARY_CLOUD_NAME && c.env.CLOUDINARY_API_KEY && c.env.CLOUDINARY_API_SECRET) {
        const result = await uploadToCloudinary(updates.image, "products", {
          cloudName: c.env.CLOUDINARY_CLOUD_NAME,
          apiKey: c.env.CLOUDINARY_API_KEY,
          apiSecret: c.env.CLOUDINARY_API_SECRET,
        });
        setFields.image = result.secure_url;
        setFields.imagePublicId = result.public_id;

        // Mark old image for cleanup after successful DB update
        oldImagePublicId = existingProduct.imagePublicId;
      } else {
        setFields.image = updates.image;
      }
    }

    const result = await products.findOneAndUpdate(
      { id: productId },
      { $set: setFields },
      { returnDocument: "after", projection: { _id: 0, imagePublicId: 0 } },
    );

    if (!result) {
      return c.json({ success: false, message: "Product not found" }, 404);
    }

    // Clean up old Cloudinary image after successful update
    if (
      oldImagePublicId &&
      c.env.CLOUDINARY_CLOUD_NAME &&
      c.env.CLOUDINARY_API_KEY &&
      c.env.CLOUDINARY_API_SECRET
    ) {
      try {
        await deleteFromCloudinary(oldImagePublicId, {
          cloudName: c.env.CLOUDINARY_CLOUD_NAME,
          apiKey: c.env.CLOUDINARY_API_KEY,
          apiSecret: c.env.CLOUDINARY_API_SECRET,
        });
      } catch (err) {
        // Log but don't fail the request — the update already succeeded
        console.error("Failed to delete old Cloudinary image:", err);
      }
    }

    await bumpConfigVersion(db).catch((e) =>
      console.error("Failed to bump config version on product update:", e),
    );

    return c.json({
      success: true,
      message: "Product updated successfully",
      product: {
        id: result.id,
        name: result.name,
        price: result.price,
        isAvailable: result.isAvailable,
      },
    });
  } catch (error) {
    console.error("Update product error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * DELETE /products/:productId
 *
 * Deletes a product permanently.
 */
productRoutes.delete("/:productId", async (c) => {
  try {
    const productId = c.req.param("productId");
    const db = c.get("db");
    const products = db.collection<ProductDoc>(COLLECTIONS.PRODUCTS);

    const product = await products.findOne({ id: productId });
    if (!product) {
      return c.json({ success: false, message: "Product not found" }, 404);
    }

    // Delete image from Cloudinary if an imagePublicId exists
    if (
      product.imagePublicId &&
      c.env.CLOUDINARY_CLOUD_NAME &&
      c.env.CLOUDINARY_API_KEY &&
      c.env.CLOUDINARY_API_SECRET
    ) {
      try {
        await deleteFromCloudinary(product.imagePublicId, {
          cloudName: c.env.CLOUDINARY_CLOUD_NAME,
          apiKey: c.env.CLOUDINARY_API_KEY,
          apiSecret: c.env.CLOUDINARY_API_SECRET,
        });
      } catch (err) {
        console.error("Cloudinary image delete error:", err);
      }
    }

    await products.deleteOne({ id: productId });
    await bumpConfigVersion(db).catch((e) =>
      console.error("Failed to bump config version on product delete:", e),
    );

    return c.json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (error) {
    console.error("Delete product error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { productRoutes };
