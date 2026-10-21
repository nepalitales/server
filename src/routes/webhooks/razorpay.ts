import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import {
  verifyRazorpayWebhookSignature,
  initiateRazorpayRefund,
} from "../../lib/razorpay";
import { recordOrderEvent } from "../../lib/order-events";
import { confirmOrderPaymentAtomic } from "../../lib/order-payment";
import { getRedisClient } from "../../lib/redis";
import type { OrderDoc } from "../../types";

const razorpayWebhookRoutes = new Hono<AppBindings>();

/**
 * POST /api/webhooks/razorpay
 *
 * Handles asynchronous server-to-server webhook notifications from Razorpay:
 * - payment.captured / order.paid: confirms order atomically, emails customer, emits live event
 * - payment.failed: records payment failure
 * - refund.processed: tracks refund completion
 */
razorpayWebhookRoutes.post("/", async (c) => {
  const redis = getRedisClient(c.env);
  let dedupKey: string | null = null;

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
    const eventId = c.req.header("x-razorpay-event-id") || payload.id;
    const db = c.get("db");
    const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

    console.log(`[Razorpay Webhook]: Received event '${event}' (${eventId || "no-id"})`);

    // Webhook Deduplication Check:
    // Check if this event was already successfully processed.
    // NOTE: We only SET this key upon successful completion so that transient DB failures
    // allow Razorpay retries to be re-processed.
    if (eventId) {
      dedupKey = `rzp:evt:${eventId}`;
      if (redis) {
        try {
          const alreadyProcessed = await redis.get(dedupKey);
          if (alreadyProcessed) {
            console.log(`[Razorpay Webhook]: Event ${eventId} (${event}) already successfully processed. Skipping duplicate.`);
            return c.json({ success: true, message: "Duplicate webhook event already processed" });
          }
        } catch (redisErr) {
          console.warn("[Razorpay Webhook]: Redis deduplication check error:", redisErr);
        }
      }
    }

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

      if (!order) {
        return c.json({ success: true, message: "Webhook acknowledged (order not found)" });
      }

      if (order.status === "pending_payment") {
        // Atomic compare-and-swap confirmation: prevents race conditions with client verify-payment
        await confirmOrderPaymentAtomic({
          db,
          orderId: order.id,
          razorpayPaymentId: razorpayPaymentId || order.payment.razorpayPaymentId,
          source: "razorpay_webhook",
          env: {
            RESEND_API_KEY: c.env.RESEND_API_KEY,
            RESEND_FROM_EMAIL: c.env.RESEND_FROM_EMAIL,
            ADMIN_NOTIFICATION_EMAIL: c.env.ADMIN_NOTIFICATION_EMAIL,
            NODE_ENV: c.env.NODE_ENV,
          },
          waitUntil: c.executionCtx?.waitUntil?.bind(c.executionCtx),
        });
      } else if (
        (order.status === "cancelled_by_customer" ||
          order.status === "cancelled_by_admin" ||
          order.status === "expired") &&
        razorpayPaymentId
      ) {
        // Double-refund guard: If the order has already been refunded or has a refund ID, skip!
        if (order.refund?.status === "refunded" || Boolean(order.refund?.razorpayRefundId)) {
          console.log(
            `[Razorpay Webhook]: Payment ${razorpayPaymentId} captured on ${order.status} order ${order.orderNumber}, but refund already completed (${order.refund?.razorpayRefundId || order.refund?.status}). Skipping duplicate refund.`,
          );
          if (order.payment?.status !== "paid") {
            await ordersCol.updateOne(
              { id: order.id },
              {
                $set: {
                  "payment.status": "paid",
                  "payment.razorpayPaymentId": razorpayPaymentId,
                  "payment.paidAt": new Date(),
                  updatedAt: new Date(),
                },
              },
            );
          }
        } else {
          // Payment was captured on an order that was cancelled or expired while payment was in-flight.
          // Trigger automatic refund so customer is never charged for an unfulfilled order.
          console.warn(
            `[Razorpay Webhook]: Payment ${razorpayPaymentId} captured on cancelled/expired order ${order.orderNumber} (${order.status}). Triggering automatic refund.`,
          );
          const now = new Date();
          const refundResult = await initiateRazorpayRefund({
            paymentId: razorpayPaymentId,
            amountInInr: order.totalAmount,
            reason: `Automatic refund: Payment captured on ${order.status} order`,
            keyId: c.env.RAZORPAY_KEY_ID,
            keySecret: c.env.RAZORPAY_KEY_SECRET,
            isDevelopment: isDev,
          });

          await ordersCol.updateOne(
            { id: order.id },
            {
              $set: {
                "payment.status": "paid",
                "payment.razorpayPaymentId": razorpayPaymentId,
                "payment.paidAt": now,
                "refund.status": refundResult.success ? "refunded" : "failed",
                "refund.amount": order.totalAmount,
                "refund.type": "full",
                "refund.reason": `Payment captured on ${order.status} order`,
                "refund.razorpayRefundId": refundResult.refundId,
                "refund.refundedAt": refundResult.success ? now : undefined,
                "refund.error": refundResult.error,
                updatedAt: now,
              },
              $push: {
                timeline: {
                  status: order.status,
                  timestamp: now,
                  note: `Payment captured via webhook on ${order.status} order. Auto-refund ${
                    refundResult.success
                      ? "issued successfully"
                      : `failed: ${refundResult.error || "unknown error"}. Queued for retry.`
                  }.`,
                },
              } as any,
            },
          );

          await recordOrderEvent(db, {
            type: "order_cancelled",
            orderId: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            summary: {
              reason: `Webhook payment on ${order.status} order`,
              refundAmount: order.totalAmount,
              refundStatus: refundResult.success ? "refunded" : "failed",
            },
          });
        }
      }
    } else if (event === "refund.processed") {
      const refundEntity = payload.payload?.refund?.entity;
      const razorpayPaymentId = refundEntity?.payment_id;
      const razorpayRefundId = refundEntity?.id;

      if (razorpayPaymentId || razorpayRefundId) {
        const filter = razorpayRefundId
          ? { "refund.razorpayRefundId": razorpayRefundId }
          : { "payment.razorpayPaymentId": razorpayPaymentId };

        const order = await ordersCol.findOne(filter);
        if (order) {
          const now = new Date();
          const refundedAmount = refundEntity?.amount
            ? refundEntity.amount / 100
            : order.refund?.amount || order.totalAmount;

          await ordersCol.updateOne(
            { id: order.id },
            {
              $set: {
                "refund.status": "refunded",
                "refund.refundedAt": now,
                updatedAt: now,
              },
              $push: {
                timeline: {
                  status: order.status,
                  timestamp: now,
                  note: `Refund of ₹${refundedAmount} processed successfully by Razorpay (${razorpayRefundId || "completed"}).`,
                },
              } as any,
            },
          );

          await recordOrderEvent(db, {
            type: "order_cancelled",
            orderId: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            summary: {
              refundStatus: "refunded",
              razorpayRefundId: razorpayRefundId || order.refund?.razorpayRefundId,
              amount: refundedAmount,
              source: "razorpay_webhook_refund_processed",
            },
          });
        }
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

    // Mark event as successfully processed in Redis AFTER successful execution
    if (redis && dedupKey) {
      await redis.set(dedupKey, "1", { ex: 86400 }).catch(() => {});
    }

    return c.json({ success: true, message: "Webhook processed successfully" });
  } catch (error) {
    // If processing threw an error, delete the dedup key so Razorpay retries are NOT blocked
    if (redis && dedupKey) {
      await redis.del(dedupKey).catch(() => {});
    }
    console.error("Razorpay webhook handler error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { razorpayWebhookRoutes };
