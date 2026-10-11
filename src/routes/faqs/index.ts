import { Hono, type Context } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { generateId } from "../../lib/crypto";
import {
  createFaqSchema,
  updateFaqSchema,
  reorderFaqsSchema,
} from "../../schemas";
import { formatZodErrors } from "../../utils";
import { authMiddleware } from "../../middleware/auth";
import { bumpConfigVersion } from "../../lib/config-version";
import type { FaqDoc } from "../../types";

const faqRoutes = new Hono<AppBindings>();

// All admin FAQ routes require authentication
faqRoutes.use("*", authMiddleware);

/**
 * GET /api/admin/faqs
 *
 * Lists all FAQs (both active and inactive), ordered by displayOrder.
 * Supports optional category filtering.
 */
faqRoutes.get("/", async (c) => {
  try {
    const category = c.req.query("category");
    const db = c.get("db");
    const faqs = db.collection<FaqDoc>(COLLECTIONS.FAQS);

    const filter: Record<string, unknown> = {};
    if (category) {
      filter.category = category;
    }

    const items = await faqs
      .find(filter, { projection: { _id: 0 } })
      .sort({ displayOrder: 1, createdAt: 1 })
      .toArray();

    return c.json({ success: true, faqs: items });
  } catch (error) {
    console.error("Get admin faqs error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * GET /api/admin/faqs/:faqId
 *
 * Returns a single FAQ by ID.
 */
faqRoutes.get("/:faqId", async (c) => {
  try {
    const faqId = c.req.param("faqId");
    const db = c.get("db");
    const faqs = db.collection<FaqDoc>(COLLECTIONS.FAQS);

    const faq = await faqs.findOne(
      { id: faqId },
      { projection: { _id: 0 } },
    );

    if (!faq) {
      return c.json({ success: false, message: "FAQ not found" }, 404);
    }

    return c.json({ success: true, faq });
  } catch (error) {
    console.error("Get FAQ by ID error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * POST /api/admin/faqs
 *
 * Creates a new FAQ entry.
 */
faqRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createFaqSchema.safeParse(body);

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

    const { question, answer, category, displayOrder, isActive } = parsed.data;
    const db = c.get("db");
    const faqs = db.collection<FaqDoc>(COLLECTIONS.FAQS);

    // If displayOrder is 0 or not given, place at the end
    let orderToSet = displayOrder;
    if (!orderToSet || orderToSet === 0) {
      const lastFaq = await faqs
        .find({}, { projection: { displayOrder: 1 } })
        .sort({ displayOrder: -1 })
        .limit(1)
        .toArray();
      const last = lastFaq[0];
      orderToSet = last ? (last.displayOrder || 0) + 1 : 1;
    }

    const now = new Date();
    const faqDoc: FaqDoc = {
      id: generateId("faq"),
      question: question.trim(),
      answer: answer.trim(),
      ...(category ? { category: category.trim() } : {}),
      displayOrder: orderToSet,
      isActive: isActive !== undefined ? isActive : true,
      createdAt: now,
      updatedAt: now,
    };

    await faqs.insertOne(faqDoc);
    await bumpConfigVersion(db, c.env).catch(() => {});

    const { _id, ...safeFaq } = faqDoc;
    return c.json(
      {
        success: true,
        message: "FAQ created successfully",
        faq: safeFaq,
      },
      201,
    );
  } catch (error) {
    console.error("Create FAQ error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

/**
 * PUT /api/admin/faqs/reorder or PATCH /api/admin/faqs/reorder
 *
 * Reorders FAQs in bulk by array of IDs.
 */
async function handleReorder(c: Context<AppBindings>) {
  try {
    const body = await c.req.json();
    const parsed = reorderFaqsSchema.safeParse(body);

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

    const { faqIds } = parsed.data;
    const db = c.get("db");
    const faqs = db.collection<FaqDoc>(COLLECTIONS.FAQS);
    const now = new Date();

    const bulkOps = faqIds.map((id, index) => ({
      updateOne: {
        filter: { id },
        update: {
          $set: {
            displayOrder: index + 1,
            updatedAt: now,
          },
        },
      },
    }));

    if (bulkOps.length > 0) {
      await faqs.bulkWrite(bulkOps);
      await bumpConfigVersion(db, c.env).catch(() => {});
    }

    return c.json({
      success: true,
      message: "FAQs reordered successfully",
    });
  } catch (error) {
    console.error("Reorder FAQs error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
}

faqRoutes.patch("/reorder", handleReorder);
faqRoutes.put("/reorder", handleReorder);

/**
 * Helper to update FAQ fields
 */
async function handleUpdateFaq(c: Context<AppBindings>) {
  try {
    const faqId = c.req.param("faqId");
    const body = await c.req.json();
    const parsed = updateFaqSchema.safeParse(body);

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
    const faqs = db.collection<FaqDoc>(COLLECTIONS.FAQS);

    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.question !== undefined) setFields.question = updates.question.trim();
    if (updates.answer !== undefined) setFields.answer = updates.answer.trim();
    if (updates.category !== undefined) setFields.category = updates.category.trim();
    if (updates.displayOrder !== undefined) setFields.displayOrder = updates.displayOrder;
    if (updates.isActive !== undefined) setFields.isActive = updates.isActive;

    const result = await faqs.findOneAndUpdate(
      { id: faqId },
      { $set: setFields },
      { returnDocument: "after", projection: { _id: 0 } },
    );

    if (!result) {
      return c.json({ success: false, message: "FAQ not found" }, 404);
    }

    await bumpConfigVersion(db, c.env).catch(() => {});

    return c.json({
      success: true,
      message: "FAQ updated successfully",
      faq: result,
    });
  } catch (error) {
    console.error("Update FAQ error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
}

/**
 * PATCH /api/admin/faqs/:faqId
 */
faqRoutes.patch("/:faqId", handleUpdateFaq);

/**
 * PUT /api/admin/faqs/:faqId
 */
faqRoutes.put("/:faqId", handleUpdateFaq);

/**
 * DELETE /api/admin/faqs/:faqId
 *
 * Deletes an FAQ by ID.
 */
faqRoutes.delete("/:faqId", async (c) => {
  try {
    const faqId = c.req.param("faqId");
    const db = c.get("db");
    const faqs = db.collection<FaqDoc>(COLLECTIONS.FAQS);

    const result = await faqs.deleteOne({ id: faqId });

    if (result.deletedCount === 0) {
      return c.json({ success: false, message: "FAQ not found" }, 404);
    }

    await bumpConfigVersion(db, c.env).catch(() => {});

    return c.json({
      success: true,
      message: "FAQ deleted successfully",
    });
  } catch (error) {
    console.error("Delete FAQ error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { faqRoutes };
