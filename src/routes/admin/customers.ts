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

    // Pagination & Stats facet
    pipeline.push({
      $facet: {
        metadata: [{ $count: "total" }],
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        stats: [
          {
            $group: {
              _id: null,
              totalCustomers: { $sum: 1 },
              totalOrders: { $sum: "$orderCount" },
              totalSpent: { $sum: "$totalSpent" },
              oneTimeCustomers: {
                $sum: { $cond: [{ $eq: ["$orderCount", 1] }, 1, 0] },
              },
              repeatCustomers: {
                $sum: { $cond: [{ $gt: ["$orderCount", 1] }, 1, 0] },
              },
              repeatSpent: {
                $sum: { $cond: [{ $gt: ["$orderCount", 1] }, "$totalSpent", 0] },
              },
              tier1: { $sum: { $cond: [{ $eq: ["$orderCount", 1] }, 1, 0] } },
              tier2: { $sum: { $cond: [{ $eq: ["$orderCount", 2] }, 1, 0] } },
              tier3to4: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ["$orderCount", 3] }, { $lte: ["$orderCount", 4] }] },
                    1,
                    0,
                  ],
                },
              },
              tier5plus: { $sum: { $cond: [{ $gte: ["$orderCount", 5] }, 1, 0] } },
            },
          },
        ],
      },
    });

    const facetResults = await usersCol.aggregate(pipeline).toArray();
    const facet = facetResults[0] || { metadata: [], data: [], stats: [] };
    const total = facet.metadata[0]?.total || 0;
    const customers = facet.data || [];
    const totalPages = Math.ceil(total / limit) || 1;

    const statsRaw = facet.stats?.[0] || {
      totalCustomers: total,
      repeatCustomers: 0,
      oneTimeCustomers: 0,
      totalOrders: 0,
      totalSpent: 0,
      repeatSpent: 0,
      tier1: 0,
      tier2: 0,
      tier3to4: 0,
      tier5plus: 0,
    };

    const totalCust = statsRaw.totalCustomers || total;
    const repeatCust = statsRaw.repeatCustomers || 0;
    const repeatRate = totalCust > 0 ? Number(((repeatCust / totalCust) * 100).toFixed(1)) : 0;
    const repeatRevenuePercentage =
      statsRaw.totalSpent > 0
        ? Number(((statsRaw.repeatSpent / statsRaw.totalSpent) * 100).toFixed(1))
        : 0;

    const stats = {
      totalCustomers: totalCust,
      repeatCustomers: repeatCust,
      oneTimeCustomers: statsRaw.oneTimeCustomers || 0,
      repeatRate,
      totalOrders: statsRaw.totalOrders || 0,
      totalSpent: statsRaw.totalSpent || 0,
      repeatSpent: statsRaw.repeatSpent || 0,
      repeatRevenuePercentage,
      avgOrdersPerCustomer: totalCust > 0 ? Number((statsRaw.totalOrders / totalCust).toFixed(1)) : 0,
      frequency: [
        { label: "1 Order (First-time)", count: statsRaw.tier1 || 0 },
        { label: "2 Orders (Returning)", count: statsRaw.tier2 || 0 },
        { label: "3–4 Orders (Regulars)", count: statsRaw.tier3to4 || 0 },
        { label: "5+ Orders (VIP Fans)", count: statsRaw.tier5plus || 0 },
      ],
    };

    return c.json({
      success: true,
      customers,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      stats,
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
