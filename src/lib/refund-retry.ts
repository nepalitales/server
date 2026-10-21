import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import { initiateRazorpayRefund } from "./razorpay";
import type { OrderDoc } from "../types";
import type { Env } from "../config/env";

export interface RefundRetryDetail {
  orderId: string;
  orderNumber: string;
  success: boolean;
  refundId?: string;
  error?: string;
}

export interface RefundRetryResult {
  attempted: number;
  succeeded: number;
  failed: number;
  details: RefundRetryDetail[];
}

/**
 * Retries failed or pending refunds for cancelled orders.
 *
 * Safe to run periodically via Cloudflare Cron Triggers or on-demand from admin dashboard.
 * Finds orders in `cancelled_by_customer` or `cancelled_by_admin` where payment was captured
 * but refund status is still `failed` or `pending`.
 */
export async function retryFailedRefunds(
  db: Db,
  env: Partial<Env>,
): Promise<RefundRetryResult> {
  const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
  const isDev = env.NODE_ENV === "development";

  // Scan for cancelled orders with captured payment whose refund is pending or failed
  const pendingOrders = await ordersCol
    .find({
      status: { $in: ["cancelled_by_customer", "cancelled_by_admin"] },
      "payment.status": "paid",
      "payment.razorpayPaymentId": { $exists: true, $ne: "" },
      "refund.status": { $in: ["failed", "pending"] },
    })
    .limit(25)
    .toArray();

  const details: RefundRetryDetail[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const order of pendingOrders) {
    const paymentId = order.payment.razorpayPaymentId;
    if (!paymentId) continue;

    const amountInInr = order.refund?.amount || order.totalAmount;
    const reason =
      order.refund?.reason || `Retry automated refund for cancelled order ${order.orderNumber}`;

    try {
      const refundResult = await initiateRazorpayRefund({
        paymentId,
        amountInInr,
        reason,
        keyId: env.RAZORPAY_KEY_ID,
        keySecret: env.RAZORPAY_KEY_SECRET,
        isDevelopment: isDev,
      });

      const now = new Date();

      if (refundResult.success) {
        await ordersCol.updateOne(
          { id: order.id },
          {
            $set: {
              "refund.status": "refunded",
              "refund.razorpayRefundId": refundResult.refundId,
              "refund.refundedAt": now,
              "refund.error": undefined,
              updatedAt: now,
            },
            $push: {
              timeline: {
                status: order.status,
                timestamp: now,
                note: `Cron retry refund succeeded via Razorpay. Refund ID: ${refundResult.refundId}`,
              },
            } as any,
          },
        );
        succeeded++;
        details.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          success: true,
          refundId: refundResult.refundId,
        });
      } else {
        await ordersCol.updateOne(
          { id: order.id },
          {
            $set: {
              "refund.status": "failed",
              "refund.error": refundResult.error,
              updatedAt: now,
            },
            $push: {
              timeline: {
                status: order.status,
                timestamp: now,
                note: `Cron retry refund attempt failed: ${refundResult.error || "unknown error"}`,
              },
            } as any,
          },
        );
        failed++;
        details.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          success: false,
          error: refundResult.error,
        });
      }
    } catch (err: any) {
      console.error(`[Refund Retry] Failed processing order ${order.orderNumber}:`, err);
      failed++;
      details.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        success: false,
        error: err.message,
      });
    }
  }

  return {
    attempted: pendingOrders.length,
    succeeded,
    failed,
    details,
  };
}
