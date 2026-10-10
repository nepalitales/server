import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { verifyRazorpayWebhookSignature } from "../../lib/razorpay";
import { recordOrderEvent } from "../../lib/order-events";
import { sendOrderConfirmationEmail } from "../../lib/email";
import { confirmSlotReservation } from "../../lib/dispatch-windows";
import type { OrderDoc } from "../../types";

const razorpayWebhookRoutes = new Hono<AppBindings>();

/**
 * POST /api/webhooks/razorpay
 *
 * Handles asynchronous server-to-server webhook notifications from Razorpay:
 * - payment.captured / order.paid: confirms order, emails the customer, emits live SSE event
 * - payment.failed: records payment failure
 * - refund.processed: tracks refund completion
 */
razorpayWebhookRoutes.post("/", async (c) => {
  try {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-razorpay-signature") || "";
    const isDev = c.env.NODE_ENV === "development";

    const isValid = await verifyRazorpayWebhookSignature(
      rawBody,
      signature,
      c.env.RAZORPAY_WEBHOOK_SECRET,
      isDev,
    );

    if (!isValid) {
      console.warn("[Razorpay Webhook]: Invalid webhook signature rejected.");
      return c.json({ success: false, message: "Invalid webhook signature" }, 400);
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event as string;
    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    console.log(`[Razorpay Webhook]: Received event '${event}'`);

    if (event === "payment.captured" || event === "order.paid") {
      const paymentEntity = payload.payload?.payment?.entity;
      const razorpayOrderId = paymentEntity?.order_id || payload.payload?.order?.entity?.id;
      const razorpayPaymentId = paymentEntity?.id;

      if (!razorpayOrderId) {
        return c.json({ success: true, message: "Webhook acknowledged (no order_id)" });
      }

      const order = await ordersCol.findOne({
        "payment.razorpayOrderId": razorpayOrderId,
      });

      if (order && order.status === "pending_payment") {
        const now = new Date();
        await ordersCol.updateOne(
          { id: order.id },
          {
            $set: {
              status: "placed",
              "payment.status": "paid",
              "payment.razorpayPaymentId": razorpayPaymentId || order.payment.razorpayPaymentId,
              "payment.paidAt": now,
              updatedAt: now,
            },
            $push: {
              timeline: {
                status: "placed",
                timestamp: now,
                note: `Payment captured via Razorpay Webhook (${event}). Order confirmed.`,
              },
            } as any,
          },
        );

        // Confirm dispatch slot reservation permanently
        if (order.dispatchDate && order.dispatchSlot?.id) {
          await confirmSlotReservation(db, {
            dateStr: order.dispatchDate,
            slotId: order.dispatchSlot.id,
            orderId: order.id,
          });
        }

        // Send itemized order confirmation email via Resend
        sendOrderConfirmationEmail({
          order,
          apiKey: c.env.RESEND_API_KEY,
          fromEmail: c.env.RESEND_FROM_EMAIL,
          adminEmail: c.env.ADMIN_NOTIFICATION_EMAIL,
          isDevelopment: isDev,
        }).catch((e) => console.error("Failed to send email confirmation via webhook:", e));

        // Push real-time SSE event to admin dashboard
        await recordOrderEvent(db, {
          type: "order_created",
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: "placed",
          summary: {
            totalAmount: order.totalAmount,
            customerName: order.customer.name,
            customerPhone: order.customer.phone,
            itemsCount: order.items.length,
            source: "razorpay_webhook",
          },
        });
      }
    } else if (event === "payment.failed") {
      const paymentEntity = payload.payload?.payment?.entity;
      const razorpayOrderId = paymentEntity?.order_id;
      const errorDescription = paymentEntity?.error_description || "Payment failed at gateway";

      if (razorpayOrderId) {
        const order = await ordersCol.findOne({
          "payment.razorpayOrderId": razorpayOrderId,
        });

        if (order && order.status === "pending_payment") {
          await ordersCol.updateOne(
            { id: order.id },
            {
              $set: {
                "payment.status": "failed",
                updatedAt: new Date(),
              },
              $push: {
                timeline: {
                  status: "pending_payment",
                  timestamp: new Date(),
                  note: `Payment failed at Razorpay: ${errorDescription}`,
                },
              } as any,
            },
          );
        }
      }
    }

    return c.json({ success: true, message: "Webhook processed successfully" });
  } catch (error) {
    console.error("Razorpay webhook handler error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { razorpayWebhookRoutes };
