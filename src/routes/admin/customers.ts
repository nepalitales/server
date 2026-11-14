import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { authMiddleware } from "../../middleware/auth";
import { adminCustomersQuerySchema } from "../../schemas";
import { formatZodErrors, escapeRegex } from "../../utils";
import type { ClientUserDoc, OrderDoc, ClientAddressDoc } from "../../types";

export const adminCustomerRoutes = new Hono<AppBindings>();

// All customer endpoints require admin authentication
adminCustomerRoutes.use("*", authMiddleware);

/**
 * GET /api/admin/customers
 *
 * Returns paginated customer order metrics:
 * - Which customer ordered how many times
 * - Delivered, active, and cancelled breakdowns
 * - Total revenue per customer
 * - First and last order timestamps
 * - Search by name, phone, email, or user ID
 * - Frequency filters (repeat, VIP, 0-order customers)
 * - Overall store customer KPIs
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

    const { page, limit, search, sortBy, sortOrder, filter } = parseResult.data;
    const db = c.get("db");
    const usersCol = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    // Build the aggregation pipeline starting from client_users
    const pipeline: any[] = [
      {
        $lookup: {
          from: COLLECTIONS.ORDERS,
          localField: "id",
          foreignField: "userId",
          as: "rawOrders",
        },
      },
      {
        $addFields: {
          orders: {
            $filter: {
              input: "$rawOrders",
              as: "o",
              cond: {
                $not: {
                  $in: ["$$o.status", ["pending_payment", "expired"]],
                },
              },
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$id",
          username: {
            $ifNull: [
              "$username",
              {
                $ifNull: [
                  { $arrayElemAt: ["$orders.customer.name", -1] },
                  "Customer",
                ],
              },
            ],
          },
          phone: {
            $ifNull: [
              "$phone",
              {
                $ifNull: [
                  { $arrayElemAt: ["$orders.customer.phone", -1] },
                  "",
                ],
              },
            ],
          },
          email: {
            $ifNull: [
              "$email",
              {
                $ifNull: [
                  { $arrayElemAt: ["$orders.customer.email", -1] },
                  "",
                ],
              },
            ],
          },
          isVerified: { $ifNull: ["$isVerified", false] },
          registeredAt: "$createdAt",
          totalOrders: { $size: "$orders" },
          deliveredOrders: {
            $size: {
              $filter: {
                input: "$orders",
                as: "o",
                cond: { $eq: ["$$o.status", "delivered"] },
              },
            },
          },
          cancelledOrders: {
            $size: {
              $filter: {
                input: "$orders",
                as: "o",
                cond: {
                  $in: [
                    "$$o.status",
                    ["cancelled_by_customer", "cancelled_by_admin"],
                  ],
                },
              },
            },
          },
          activeOrders: {
            $size: {
              $filter: {
                input: "$orders",
                as: "o",
                cond: {
                  $in: [
                    "$$o.status",
                    [
                      "placed",
                      "preparing",
                      "ready",
                      "porter_booked",
                      "porter_failed",
                      "out_for_delivery",
                    ],
                  ],
                },
              },
            },
          },
          totalSpent: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: "$orders",
                    as: "o",
                    cond: {
                      $not: {
                        $in: [
                          "$$o.status",
                          ["cancelled_by_customer", "cancelled_by_admin"],
                        ],
                      },
                    },
                  },
                },
                as: "po",
                in: "$$po.totalAmount",
              },
            },
          },
          firstOrderAt: { $min: "$orders.createdAt" },
          lastOrderAt: { $max: "$orders.createdAt" },
        },
      },
    ];

    // Search filter
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

    // Frequency filter
    if (filter === "ordered") {
      pipeline.push({ $match: { totalOrders: { $gt: 0 } } });
    } else if (filter === "repeat") {
      pipeline.push({ $match: { totalOrders: { $gte: 2 } } });
    } else if (filter === "frequent") {
      pipeline.push({ $match: { totalOrders: { $gte: 5 } } });
    } else if (filter === "no_orders") {
      pipeline.push({ $match: { totalOrders: 0 } });
    }

    // Sort order
    const sortDir = sortOrder === "asc" ? 1 : -1;
    const sortStage: Record<string, 1 | -1> = {};

    switch (sortBy) {
      case "spent":
        sortStage.totalSpent = sortDir;
        sortStage.totalOrders = -1;
        break;
      case "recent":
        sortStage.lastOrderAt = sortDir;
        sortStage.totalOrders = -1;
        break;
      case "joined":
        sortStage.registeredAt = sortDir;
        break;
      case "name":
        sortStage.username = sortDir;
        break;
      case "orders":
      default:
        sortStage.totalOrders = sortDir;
        sortStage.totalSpent = -1;
        sortStage.lastOrderAt = -1;
        break;
    }

    pipeline.push({ $sort: sortStage });

    // Pagination facet
    pipeline.push({
      $facet: {
        metadata: [{ $count: "total" }],
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
      },
    });

    // Execute list aggregation and high-level KPI aggregations in parallel
    const [facetResults, totalUsers, orderStatsAgg] = await Promise.all([
      usersCol.aggregate(pipeline).toArray(),
      usersCol.countDocuments(),
      ordersCol
        .aggregate<{
          _id: null;
          orderingCustomers: number;
          repeatCustomers: number;
          frequentCustomers: number;
          totalOrdersPlaced: number;
          totalRevenue: number;
        }>([
          { $match: { status: { $nin: ["pending_payment", "expired"] } } },
          {
            $group: {
              _id: "$userId",
              ordersCount: { $sum: 1 },
              userSpent: {
                $sum: {
                  $cond: [
                    {
                      $in: [
                        "$status",
                        ["cancelled_by_customer", "cancelled_by_admin"],
                      ],
                    },
                    0,
                    "$totalAmount",
                  ],
                },
              },
            },
          },
          {
            $group: {
              _id: null,
              orderingCustomers: { $sum: 1 },
              repeatCustomers: {
                $sum: { $cond: [{ $gte: ["$ordersCount", 2] }, 1, 0] },
              },
              frequentCustomers: {
                $sum: { $cond: [{ $gte: ["$ordersCount", 5] }, 1, 0] },
              },
              totalOrdersPlaced: { $sum: "$ordersCount" },
              totalRevenue: { $sum: "$userSpent" },
            },
          },
        ])
        .toArray(),
    ]);

    const facet = facetResults[0] || { metadata: [], data: [] };
    const total = facet.metadata[0]?.total || 0;
    const customers = facet.data || [];
    const totalPages = Math.ceil(total / limit) || 1;

    const statsRaw = orderStatsAgg[0] || {
      orderingCustomers: 0,
      repeatCustomers: 0,
      frequentCustomers: 0,
      totalOrdersPlaced: 0,
      totalRevenue: 0,
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
      stats: {
        totalCustomers: totalUsers,
        orderingCustomers: statsRaw.orderingCustomers || 0,
        repeatCustomers: statsRaw.repeatCustomers || 0,
        frequentCustomers: statsRaw.frequentCustomers || 0,
        totalOrdersPlaced: statsRaw.totalOrdersPlaced || 0,
        totalRevenue: Math.round(statsRaw.totalRevenue || 0),
      },
    });
  } catch (error: any) {
    console.error("[Admin Customers API Error]:", error);
    return c.json(
      {
        success: false,
        message: "Failed to fetch customer insights: " + (error?.message || "Unknown error"),
      },
      500,
    );
  }
});

/**
 * GET /api/admin/customers/:userId
 *
 * Detailed customer profile, lifetime metrics, delivery addresses,
 * and complete chronological order history.
 */
adminCustomerRoutes.get("/:userId", async (c) => {
  try {
    const userId = c.req.param("userId");
    const db = c.get("db");
    const usersCol = db.collection<ClientUserDoc>(COLLECTIONS.CLIENT_USERS);
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const addressesCol = db.collection<ClientAddressDoc>(COLLECTIONS.CLIENT_ADDRESSES);

    const [user, orders, addresses] = await Promise.all([
      usersCol.findOne({ id: userId }),
      ordersCol
        .find({ userId, status: { $nin: ["pending_payment", "expired"] } })
        .sort({ createdAt: -1 })
        .toArray(),
      addressesCol.find({ userId }).toArray(),
    ]);

    if (!user && orders.length === 0) {
      return c.json({ success: false, message: "Customer not found" }, 404);
    }

    const totalOrders = orders.length;
    const deliveredOrders = orders.filter((o) => o.status === "delivered").length;
    const cancelledOrders = orders.filter(
      (o) =>
        o.status === "cancelled_by_customer" || o.status === "cancelled_by_admin",
    ).length;
    const activeOrders = orders.filter((o) =>
      [
        "placed",
        "preparing",
        "ready",
        "porter_booked",
        "porter_failed",
        "out_for_delivery",
      ].includes(o.status),
    ).length;

    const totalSpent = orders
      .filter(
        (o) =>
          o.status !== "cancelled_by_customer" &&
          o.status !== "cancelled_by_admin",
      )
      .reduce((sum, o) => sum + (o.totalAmount || 0), 0);

    const successfulOrdersCount = totalOrders - cancelledOrders;
    const avgOrderValue =
      successfulOrdersCount > 0
        ? Math.round(totalSpent / successfulOrdersCount)
        : 0;

    return c.json({
      success: true,
      customer: {
        userId,
        username: user?.username || orders[0]?.customer?.name || "Customer",
        phone: user?.phone || orders[0]?.customer?.phone || "",
        email: user?.email || orders[0]?.customer?.email || "",
        isVerified: user?.isVerified ?? false,
        registeredAt:
          user?.createdAt ||
          orders[orders.length - 1]?.createdAt ||
          new Date(),
        stats: {
          totalOrders,
          deliveredOrders,
          cancelledOrders,
          activeOrders,
          totalSpent: Math.round(totalSpent),
          avgOrderValue,
          firstOrderAt: orders[orders.length - 1]?.createdAt || null,
          lastOrderAt: orders[0]?.createdAt || null,
        },
        addresses: addresses.map((addr) => ({
          id: addr.id,
          label: addr.label,
          street: addr.street,
          building: addr.building,
          flatNumber: addr.flatNumber,
          city: addr.city,
          pincode: addr.pincode,
          isDefault: addr.isDefault,
        })),
        orders: orders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          orderType: o.orderType,
          totalAmount: o.totalAmount,
          itemTotal: o.itemTotal,
          deliveryFee: o.deliveryFee,
          discount: o.discount,
          itemsCount:
            o.items?.reduce((s, it) => s + (it.quantity || 1), 0) || 0,
          items:
            o.items?.map((it) => ({
              productName: it.productName,
              quantity: it.quantity,
              subtotal: it.subtotal,
            })) || [],
          dispatchDate: o.dispatchDate,
          dispatchSlot: o.dispatchSlot,
          createdAt: o.createdAt,
        })),
      },
    });
  } catch (error: any) {
    console.error("[Admin Customer Detail Error]:", error);
    return c.json(
      {
        success: false,
        message: "Failed to fetch customer profile: " + (error?.message || "Unknown error"),
      },
      500,
    );
  }
});
