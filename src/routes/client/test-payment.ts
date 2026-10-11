import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
  initiateRazorpayRefund,
} from "../../lib/razorpay";
import { sendOrderConfirmationEmail, sendOrderStatusEmail } from "../../lib/email";
import { recordOrderEvent } from "../../lib/order-events";
import { TEST_CHECKOUT_HTML } from "./test-payment-page";
import type { OrderDoc } from "../../types";

export const testPaymentRoutes = new Hono<AppBindings>();

/**
 * GET /api/client/test-payment/page
 *
 * Serves the standalone interactive HTML test suite.
 */
testPaymentRoutes.get("/page", (c) => {
  return c.html(TEST_CHECKOUT_HTML);
});

/**
 * Helper to generate order IDs
 */
function generateTestId(prefix: string): string {
  return `${prefix}_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * POST /api/client/test-payment/create-order
 *
 * Creates a real ₹2 live test order in Razorpay and records it in MongoDB.
 */
testPaymentRoutes.post("/create-order", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const customerName = (body.customerName || "Ankit Bhavarthe (Live Test)").trim();
    const customerPhone = (body.customerPhone || "917678097659").trim();
    const customerEmail = (body.customerEmail || "bhavartheankit@gmail.com").toLowerCase().trim();
    const amountInInr = 2; // Fixed ₹2 test amount

    const db = c.get("db");
    const isDev = c.env.NODE_ENV === "development";
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const orderId = generateTestId("order");
    const orderNumber = `NT-TEST-${Date.now().toString().slice(-4)}`;

    // 1. Create real order on Razorpay
    const rzpOrder = await createRazorpayOrder({
      amountInInr,
      receiptId: orderId,
      keyId: c.env.RAZORPAY_KEY_ID,
      keySecret: c.env.RAZORPAY_KEY_SECRET,
      isDevelopment: isDev,
    });

    if (!rzpOrder.success || !rzpOrder.razorpayOrderId) {
      return c.json(
        {
          success: false,
          message: rzpOrder.error || "Failed to create Razorpay test order",
        },
        500,
      );
    }

    const now = new Date();

    // 2. Insert test order document into MongoDB
    const testOrder: OrderDoc = {
      id: orderId,
      orderNumber,
      userId: "user_test_runner",
      customer: {
        name: customerName,
        phone: customerPhone,
        email: customerEmail,
      },
      deliveryAddress: {
        street: "Metropolis Riveria, Kasarvadavali, Ghodbunder Road",
        city: "Thane",
        pincode: "400615",
        borzoFormat: {
          address: "Metropolis Riveria, Kasarvadavali, Thane, Maharashtra 400615",
          note: "Live ₹2 Test Order",
        },
      },
      orderType: "pickup",
      items: [
        {
          productId: "prod_live_test_2rs",
          productName: "Nepali Tales Live Payment Verification (₹2)",
          price: amountInInr,
          quantity: 1,
          subtotal: amountInInr,
        },
      ],
      itemTotal: amountInInr,
      deliveryFee: 0,
      discount: 0,
      totalAmount: amountInInr,
      notes: "Live end-to-end UPI payment & auto-refund test",
      status: "pending_payment",
      canCustomerCancelUntil: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours window
      payment: {
        provider: "razorpay",
        razorpayOrderId: rzpOrder.razorpayOrderId,
        status: "pending",
      },
      timeline: [
        {
          status: "pending_payment",
          timestamp: now,
          note: `Live ₹2 test order created. Awaiting Razorpay payment.`,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    await ordersCol.insertOne(testOrder as any);

    return c.json({
      success: true,
      message: "₹2 Razorpay test order created successfully",
      orderId,
      orderNumber,
      razorpayOrderId: rzpOrder.razorpayOrderId,
      keyId: c.env.RAZORPAY_KEY_ID,
      amount: rzpOrder.amount, // in paise (200)
      customer: {
        name: customerName,
        email: customerEmail,
        phone: customerPhone,
      },
    });
  } catch (err: any) {
    console.error("Test payment create-order error:", err);
    return c.json({ success: false, message: err.message || "Internal error" }, 500);
  }
});

/**
 * POST /api/client/test-payment/verify
 *
 * Verifies Razorpay payment signature, confirms order, and emails customer.
 */
testPaymentRoutes.post("/verify", async (c) => {
  try {
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = await c.req.json();

    if (!orderId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return c.json({ success: false, message: "Missing required payment fields" }, 400);
    }

    const db = c.get("db");
    const isDev = c.env.NODE_ENV === "development";
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const order = await ordersCol.findOne({ id: orderId });
    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    // Verify signature
    const isValid = await verifyRazorpaySignature({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      keySecret: c.env.RAZORPAY_KEY_SECRET,
      isDevelopment: isDev,
    });

    if (!isValid) {
      return c.json({ success: false, message: "Invalid Razorpay payment signature" }, 400);
    }

    const now = new Date();

    await ordersCol.updateOne(
      { id: orderId },
      {
        $set: {
          status: "placed",
          "payment.status": "paid",
          "payment.razorpayPaymentId": razorpayPaymentId,
          "payment.razorpaySignature": razorpaySignature,
          "payment.paidAt": now,
          updatedAt: now,
        },
        $push: {
          timeline: {
            status: "placed",
            timestamp: now,
            note: `Payment verified via Razorpay Checkout (Payment ID: ${razorpayPaymentId})`,
          },
        } as any,
      },
    );

    const updated = await ordersCol.findOne({ id: orderId });

    // Send order confirmation email
    if (order.customer?.email) {
      sendOrderConfirmationEmail({
        order: updated || order,
        apiKey: c.env.RESEND_API_KEY,
        fromEmail: c.env.RESEND_FROM_EMAIL,
        adminEmail: c.env.ADMIN_NOTIFICATION_EMAIL,
        isDevelopment: isDev,
      }).catch((e) => console.error("Failed to send test confirmation email:", e));
    }

    await recordOrderEvent(db, {
      type: "order_created",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "placed",
      summary: {
        totalAmount: order.totalAmount,
        customerName: order.customer.name,
        paymentId: razorpayPaymentId,
        source: "test_checkout",
      },
    });

    return c.json({
      success: true,
      message: "Payment successfully verified and order confirmed!",
      orderId,
      paymentId: razorpayPaymentId,
    });
  } catch (err: any) {
    console.error("Test payment verify error:", err);
    return c.json({ success: false, message: err.message || "Internal error" }, 500);
  }
});

/**
 * POST /api/client/test-payment/cancel-and-refund
 *
 * Cancels the test order and calls Razorpay's live Refund API to refund ₹2 back to the customer's account.
 */
testPaymentRoutes.post("/cancel-and-refund", async (c) => {
  try {
    const { orderId } = await c.req.json();
    if (!orderId) {
      return c.json({ success: false, message: "orderId is required" }, 400);
    }

    const db = c.get("db");
    const isDev = c.env.NODE_ENV === "development";
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    const order = await ordersCol.findOne({ id: orderId });
    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    if (!order.payment.razorpayPaymentId) {
      return c.json({ success: false, message: "No payment ID recorded on this order" }, 400);
    }

    // Call Razorpay Refund API
    const refundRes = await initiateRazorpayRefund({
      paymentId: order.payment.razorpayPaymentId,
      amountInInr: order.totalAmount, // ₹2
      reason: "Live Test: Customer initiated automatic cancellation refund",
      keyId: c.env.RAZORPAY_KEY_ID,
      keySecret: c.env.RAZORPAY_KEY_SECRET,
      isDevelopment: isDev,
    });

    if (!refundRes.success) {
      return c.json(
        {
          success: false,
          message: `Razorpay refund failed: ${refundRes.error}`,
        },
        500,
      );
    }

    const now = new Date();

    await ordersCol.updateOne(
      { id: orderId },
      {
        $set: {
          status: "cancelled_by_customer",
          refund: {
            status: "refunded",
            amount: order.totalAmount,
            type: "full",
            reason: "Customer cancelled before order window closed",
            razorpayRefundId: refundRes.refundId,
            refundedAt: now,
          },
          updatedAt: now,
        },
        $push: {
          timeline: {
            status: "cancelled_by_customer",
            timestamp: now,
            note: `Order cancelled. ₹${order.totalAmount} refunded via Razorpay (Refund ID: ${refundRes.refundId})`,
          },
        } as any,
      },
    );

    const updated = await ordersCol.findOne({ id: orderId });

    // Send cancellation & refund email notice
    if (order.customer?.email) {
      sendOrderStatusEmail({
        order: updated || order,
        status: "cancelled_by_customer",
        note: `Full refund of ₹${order.totalAmount} has been processed via Razorpay (ID: ${refundRes.refundId}).`,
        apiKey: c.env.RESEND_API_KEY,
        fromEmail: c.env.RESEND_FROM_EMAIL,
        isDevelopment: isDev,
      }).catch((e) => console.error("Failed to send test refund email:", e));
    }

    await recordOrderEvent(db, {
      type: "order_cancelled",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "cancelled_by_customer",
      summary: {
        refundId: refundRes.refundId,
        refundAmount: order.totalAmount,
      },
    });

    return c.json({
      success: true,
      message: "Order cancelled and ₹2 refund successfully initiated via Razorpay!",
      refundId: refundRes.refundId,
      refundAmount: order.totalAmount,
      status: refundRes.status,
      speedProcessed: refundRes.speedProcessed,
      speedRequested: refundRes.speedRequested,
    });
  } catch (err: any) {
    console.error("Test payment cancel-and-refund error:", err);
    return c.json({ success: false, message: err.message || "Internal error" }, 500);
  }
});

/**
 * GET /api/client/test-payment/status/:orderId
 *
 * Check live order status, payment status, and refund status.
 */
testPaymentRoutes.post("/status", async (c) => {
  try {
    const { orderId } = await c.req.json();
    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
    const order = await ordersCol.findOne({ id: orderId });

    if (!order) {
      return c.json({ success: false, message: "Order not found" }, 404);
    }

    return c.json({
      success: true,
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        totalAmount: order.totalAmount,
        payment: order.payment,
        refund: order.refund,
        timeline: order.timeline,
      },
    });
  } catch (err: any) {
    return c.json({ success: false, message: err.message }, 500);
  }
});
