import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import { confirmSlotReservation } from "./dispatch-windows";
import { sendOrderConfirmationEmail } from "./email";
import { recordOrderEvent } from "./order-events";
import type { OrderDoc } from "../types";

export interface ConfirmOrderPaymentParams {
  db: Db;
  orderId: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  source: "client_verification" | "razorpay_webhook";
  env: {
    RESEND_API_KEY?: string;
    RESEND_FROM_EMAIL?: string;
    ADMIN_NOTIFICATION_EMAIL?: string;
    NODE_ENV?: string;
  };
  waitUntil?: (promise: Promise<any>) => void;
}

export interface ConfirmOrderPaymentResult {
  success: boolean;
  isFirstConfirmation: boolean;
  order: OrderDoc | null;
  message?: string;
}

/**
 * Atomically transitions an order from "pending_payment" to "placed".
 *
 * Guarantees that only ONE caller (either POST /verify-payment or the Razorpay webhook)
 * performs the state transition, slot confirmation, confirmation email dispatch,
 * and real-time dashboard event broadcast.
 *
 * If the order was already confirmed by the concurrent caller, returns idempotent success
 * without re-sending emails or re-firing duplicate events.
 */
export async function confirmOrderPaymentAtomic(
  params: ConfirmOrderPaymentParams,
): Promise<ConfirmOrderPaymentResult> {
  const { db, orderId, razorpayPaymentId, razorpaySignature, source, env, waitUntil } = params;
  const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
  const now = new Date();

  // 1. Atomic compare-and-swap: only matches if status is pending_payment
  const updatedDoc = await ordersCol.findOneAndUpdate(
    {
      id: orderId,
      status: "pending_payment",
    },
    {
      $set: {
        status: "placed",
        "payment.status": "paid",
        ...(razorpayPaymentId ? { "payment.razorpayPaymentId": razorpayPaymentId } : {}),
        ...(razorpaySignature ? { "payment.razorpaySignature": razorpaySignature } : {}),
        "payment.paidAt": now,
        updatedAt: now,
      },
      $push: {
        timeline: {
          status: "placed",
          timestamp: now,
          note:
            source === "client_verification"
              ? "Payment verified successfully. Order confirmed."
              : "Payment captured via Razorpay Webhook. Order confirmed.",
        },
      } as any,
    },
    { returnDocument: "after" },
  );

  // 2. THIS caller successfully won the race and transitioned the order
  if (updatedDoc) {
    // Permanently confirm dispatch slot reservation
    if (updatedDoc.dispatchDate && updatedDoc.dispatchSlot?.id) {
      await confirmSlotReservation(db, {
        dateStr: updatedDoc.dispatchDate,
        slotId: updatedDoc.dispatchSlot.id,
        orderId: updatedDoc.id,
      });
    }

    // Send itemized order confirmation email via Resend in background
    const isDev = env.NODE_ENV === "development";
    const emailPromise = sendOrderConfirmationEmail({
      order: updatedDoc,
      apiKey: env.RESEND_API_KEY,
      fromEmail: env.RESEND_FROM_EMAIL,
      adminEmail: env.ADMIN_NOTIFICATION_EMAIL,
      isDevelopment: isDev,
    }).catch((e) =>
      console.error(`[OrderPayment]: Failed to send confirmation email (${source}):`, e),
    );

    if (waitUntil) {
      waitUntil(emailPromise);
    } else {
      void emailPromise;
    }

    // Broadcast Real-Time SSE/Live Event to Admin Dashboard
    await recordOrderEvent(db, {
      type: "order_created",
      orderId: updatedDoc.id,
      orderNumber: updatedDoc.orderNumber,
      status: "placed",
      summary: {
        totalAmount: updatedDoc.totalAmount,
        customerName: updatedDoc.customer.name,
        customerPhone: updatedDoc.customer.phone,
        itemsCount: updatedDoc.items.length,
        source,
      },
    });

    return {
      success: true,
      isFirstConfirmation: true,
      order: updatedDoc,
    };
  }

  // 3. Document was not in "pending_payment" status. Check current status.
  const existingOrder = await ordersCol.findOne({ id: orderId });
  if (!existingOrder) {
    return {
      success: false,
      isFirstConfirmation: false,
      order: null,
      message: "Order not found",
    };
  }

  if (existingOrder.status === "placed" && existingOrder.payment?.status === "paid") {
    // Idempotent success: already confirmed by the concurrent caller
    return {
      success: true,
      isFirstConfirmation: false,
      order: existingOrder,
      message: "Payment already verified and confirmed.",
    };
  }

  return {
    success: false,
    isFirstConfirmation: false,
    order: existingOrder,
    message: `Order is already in '${existingOrder.status}' status.`,
  };
}
