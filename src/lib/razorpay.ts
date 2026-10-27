import { timingSafeEqual } from "node:crypto";

/**
 * Razorpay Payment Gateway integration module.
 *
 * Provides Razorpay order creation, payment signature verification,
 * and refunds. In development mode or when keys are omitted, provides
 * transparent simulation for seamless end-to-end testing.
 */

/**
 * Constant-time hex string comparison to prevent timing side-channel attacks.
 */
function safeCompareHex(a: string, b: string): boolean {
  try {
    const cleanA = a.trim().toLowerCase();
    const cleanB = b.trim().toLowerCase();
    const bufA = Buffer.from(cleanA, "hex");
    const bufB = Buffer.from(cleanB, "hex");
    if (bufA.length === 0 || bufB.length === 0 || bufA.length !== bufB.length) {
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export interface CreateOrderParams {
  amountInInr: number;
  receiptId: string; // our internal order ID
  keyId?: string;
  keySecret?: string;
  isDevelopment?: boolean;
}

export interface RazorpayOrderResult {
  success: boolean;
  razorpayOrderId: string;
  amount: number; // in paise (e.g. 100 INR = 10000 paise)
  currency: string;
  isSimulated: boolean;
  error?: string;
}

export interface VerifyPaymentParams {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  keySecret?: string;
  isDevelopment?: boolean;
}

export interface RefundParams {
  paymentId: string;
  amountInInr?: number; // optional, full refund if omitted
  reason?: string;
  speed?: "optimum" | "normal";
  keyId?: string;
  keySecret?: string;
  isDevelopment?: boolean;
}

export interface RazorpayRefundResult {
  success: boolean;
  refundId: string;
  amount: number;
  status: string;
  speedProcessed?: string;
  speedRequested?: string;
  isSimulated: boolean;
  error?: string;
}

/**
 * Creates an order in Razorpay (or mock in development).
 */
export async function createRazorpayOrder(
  params: CreateOrderParams,
): Promise<RazorpayOrderResult> {
  const { amountInInr, receiptId, keyId, keySecret, isDevelopment } = params;
  const amountInPaise = Math.round(amountInInr * 100);

  // In development mode, allow transparent mock order generation if keys are not configured
  if (!keyId || !keySecret) {
    if (isDevelopment) {
      const mockId = `order_mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      return {
        success: true,
        razorpayOrderId: mockId,
        amount: amountInPaise,
        currency: "INR",
        isSimulated: true,
      };
    }

    return {
      success: false,
      razorpayOrderId: "",
      amount: amountInPaise,
      currency: "INR",
      isSimulated: false,
      error: "Payment gateway credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are not configured.",
    };
  }

  const basicAuth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  try {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountInPaise,
        currency: "INR",
        receipt: receiptId,
      }),
    });

    const data = (await res.json()) as any;

    if (!res.ok) {
      const msg = data?.error?.description || `Razorpay order creation failed: ${res.status}`;
      console.error("Razorpay order error:", data);

      if (isDevelopment) {
        return {
          success: true,
          razorpayOrderId: `order_mock_${Date.now().toString(36)}`,
          amount: amountInPaise,
          currency: "INR",
          isSimulated: true,
        };
      }

      return {
        success: false,
        razorpayOrderId: "",
        amount: amountInPaise,
        currency: "INR",
        isSimulated: false,
        error: msg,
      };
    }

    return {
      success: true,
      razorpayOrderId: data.id,
      amount: data.amount,
      currency: data.currency,
      isSimulated: false,
    };
  } catch (error: any) {
    console.error("Razorpay network error:", error);
    if (isDevelopment) {
      return {
        success: true,
        razorpayOrderId: `order_mock_${Date.now().toString(36)}`,
        amount: amountInPaise,
        currency: "INR",
        isSimulated: true,
      };
    }

    return {
      success: false,
      razorpayOrderId: "",
      amount: amountInPaise,
      currency: "INR",
      isSimulated: false,
      error: error.message,
    };
  }
}

/**
 * Verifies Razorpay payment signature using HMAC SHA256.
 */
export async function verifyRazorpaySignature(
  params: VerifyPaymentParams,
): Promise<boolean> {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, keySecret, isDevelopment } = params;

  // In simulated dev testing, accept mock signatures ONLY when running in development mode
  if (isDevelopment) {
    if (
      razorpayOrderId.startsWith("order_mock_") ||
      razorpaySignature.startsWith("sig_mock_") ||
      !keySecret
    ) {
      return true;
    }
  }

  // In production, keySecret is strictly required and mock signatures are rejected
  if (!keySecret) {
    console.error("[Razorpay Security]: RAZORPAY_KEY_SECRET is not configured. Rejecting payment verification.");
    return false;
  }

  const payload = `${razorpayOrderId}|${razorpayPaymentId}`;
  const keyData = new TextEncoder().encode(keySecret);
  const msgData = new TextEncoder().encode(payload);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const expectedSignature = Buffer.from(signatureBuffer).toString("hex");

  return safeCompareHex(expectedSignature, razorpaySignature);
}

/**
 * Initiates a full or partial refund on a paid Razorpay transaction.
 */
export async function initiateRazorpayRefund(
  params: RefundParams,
): Promise<RazorpayRefundResult> {
  const { paymentId, amountInInr, reason, speed = "optimum", keyId, keySecret, isDevelopment } = params;
  const amountInPaise = amountInInr ? Math.round(amountInInr * 100) : undefined;

  // Mock / Dev fallback ONLY when in development mode
  if (isDevelopment && (!keyId || !keySecret || paymentId.startsWith("pay_mock_"))) {
    return {
      success: true,
      refundId: `rfnd_mock_${Date.now().toString(36)}`,
      amount: amountInPaise ?? 0,
      status: "processed",
      speedProcessed: "instant",
      speedRequested: speed,
      isSimulated: true,
    };
  }

  if (!keyId || !keySecret) {
    return {
      success: false,
      refundId: "",
      amount: 0,
      status: "failed",
      isSimulated: false,
      error: "Razorpay credentials not configured for refund.",
    };
  }

  const basicAuth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const payload: Record<string, unknown> = {};
  if (speed === "optimum") {
    payload.speed = "optimum";
  }
  if (amountInPaise) payload.amount = amountInPaise;
  if (reason) payload.notes = { reason };

  try {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as any;

    if (!res.ok) {
      const msg = data?.error?.description || `Razorpay refund failed: ${res.status}`;

      // If Razorpay reports that the payment has already been refunded, treat as idempotent success
      if (
        typeof msg === "string" &&
        /already been (fully )?refunded|payment.*already.*refund|cannot be refunded.*already/i.test(msg)
      ) {
        console.log(
          `[Razorpay Refund]: Payment ${paymentId} is already refunded at Razorpay. Treating as idempotent success.`,
        );
        return {
          success: true,
          refundId: data?.error?.metadata?.refund_id || `rfnd_verified_${paymentId}`,
          amount: amountInPaise ?? 0,
          status: "processed",
          isSimulated: false,
        };
      }

      // If instant refund failed due to lack of merchant refund reserve balance,
      // seamlessly retry as a standard transaction reversal (which doesn't require extra balance)
      if (
        speed === "optimum" &&
        typeof msg === "string" &&
        /enough balance|insufficient balance/i.test(msg)
      ) {
        console.warn(
          `[Razorpay Refund]: Instant payout unavailable (${msg}). Retrying as standard payment reversal...`,
        );
        return initiateRazorpayRefund({
          ...params,
          speed: "normal",
        });
      }

      return {
        success: false,
        refundId: "",
        amount: 0,
        status: "failed",
        isSimulated: false,
        error: msg,
      };
    }

    return {
      success: true,
      refundId: data.id,
      amount: data.amount,
      status: data.status,
      speedProcessed: data.speed_processed,
      speedRequested: data.speed_requested,
      isSimulated: false,
    };
  } catch (error: any) {
    return {
      success: false,
      refundId: "",
      amount: 0,
      status: "failed",
      isSimulated: false,
      error: error.message,
    };
  }
}

/**
 * Verifies the X-Razorpay-Signature header against the raw webhook body.
 */
export async function verifyRazorpayWebhookSignature(
  rawBody: string,
  signature: string,
  webhookSecret?: string,
  isDevelopment?: boolean,
): Promise<boolean> {
  if (isDevelopment && (!webhookSecret || signature.startsWith("sig_mock_"))) {
    return true;
  }

  if (!webhookSecret) {
    return false;
  }

  const keyData = new TextEncoder().encode(webhookSecret);
  const msgData = new TextEncoder().encode(rawBody);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const expectedSignature = Buffer.from(signatureBuffer).toString("hex");

  return safeCompareHex(expectedSignature, signature);
}

