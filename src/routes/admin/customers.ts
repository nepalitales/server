import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { authMiddleware } from "../../middleware/auth";
import { adminCustomersQuerySchema } from "../../schemas";
import { formatZodErrors, escapeRegex } from "../../utils";
import type { ClientUserDoc } from "../../types";

export const adminCustomerRoutes = new Hono<AppBindings>();

// All customer endpoints require admin authentication
adminCustomerRoutes.use("*", authMiddleware);

/**
 * GET /api/admin/customers
 *
 * Lightweight endpoint returning which customer ordered how many times:
 * - Customer username, phone, email
 * - Simple orderCount
 * - Total spent
 * - Last order date
 */
adminCustomerRoutes.get("/", async (c) => {
  try {
    const parseResult = adminCustomersQuerySchema.safeParse(c.req.query());
    if (!parseResult.success) {
      return c.json(
        {
          success: false,
          message: "Invalid query parameters",
          errors: formatZodErrors(parseResult.error),
        },
        400,
      );
    }

    const { page, limit, search } = parseResult.data;
    const db = c.get("db");
    const usersCol = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);

    const pipeline: any[] = [
      {
        $lookup: {
          from: COLLECTIONS.ORDERS,
          let: { uId: "$id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$userId", "$$uId"] },
                status: { $nin: ["pending_payment", "expired"] },
              },
            },
            {
              $project: {
                _id: 1,
                totalAmount: 1,
                createdAt: 1,
              },
            },
          ],
          as: "userOrders",
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$id",
          username: { $ifNull: ["$username", "Customer"] },
          phone: { $ifNull: ["$phone", ""] },
          email: { $ifNull: ["$email", ""] },
          orderCount: { $size: "$userOrders" },
          totalOrders: { $size: "$userOrders" },
          totalSpent: { $sum: "$userOrders.totalAmount" },
          lastOrderAt: { $max: "$userOrders.createdAt" },
        },
      },
    ];

    if (search && search.trim()) {
      const regex = { $regex: escapeRegex(search.trim()), $options: "i" };
      pipeline.push({
        $match: {
          $or: [
            { username: regex },
            { phone: regex },
            { email: regex },
            { userId: regex },
          ],
        },
      });
    }

    // Sort by orderCount descending
    pipeline.push({
      $sort: { orderCount: -1, lastOrderAt: -1 },
    });

    // Pagination facet
    pipeline.push({
      $facet: {
        metadata: [{ $count: "total" }],
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
      },
    });

    const facetResults = await usersCol.aggregate(pipeline).toArray();
    const facet = facetResults[0] || { metadata: [], data: [] };
    const total = facet.metadata[0]?.total || 0;
    const customers = facet.data || [];
    const totalPages = Math.ceil(total / limit) || 1;

    return c.json({
      success: true,
      customers,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error: any) {
    console.error("[Admin Customers API Error]:", error);
    return c.json(
      {
        success: false,
        message: "Failed to fetch customers: " + (error?.message || "Unknown error"),
      },
      500,
    );
  }
});
