/**
 * Resend Email Client and Templates for Nepali Tales.
 *
 * Implements Resend REST API integration for:
 * 1. Customer Email OTP verification (Sign in / Sign up)
 * 2. Order Confirmation with full itemized invoice & delivery details
 * 3. Real-time Order Status updates (Cooking, Porter Assigned with live tracking, Delivered)
 * 4. Cancellation & Refund notices
 * 5. Kitchen Admin alerts on new orders
 *
 * In development or when RESEND_API_KEY is not configured, it safely simulates
 * and logs email contents to the console so local and sandbox testing works seamlessly.
 */

import type { OrderDoc, OrderStatus } from "../types";
import { generateOrderInvoicePdf, uint8ArrayToBase64 } from "./pdf-invoice";

export interface EmailAttachment {
  filename: string;
  content: string; // base64 encoded
}

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  apiKey?: string;
  from?: string;
  isDevelopment?: boolean;
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  success: boolean;
  provider: "resend" | "dev_simulated";
  id?: string;
  error?: string;
}

/**
 * Base email sender utilizing the Resend REST API (Cloudflare Workers native fetch).
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const { to, subject, html, text, apiKey, from, isDevelopment, attachments } = options;
  const recipients = Array.isArray(to) ? to : [to];
  const fromAddress = from || "Nepali Tales <orders@nepalitales.com>";

  // Simulate if no API key is provided
  if (!apiKey) {
    console.log(
      `\n--------------------------------------------------\n` +
      `[Resend Email Simulator]\n` +
      `From        : ${fromAddress}\n` +
      `To          : ${recipients.join(", ")}\n` +
      `Subject     : ${subject}\n` +
      `Attachments : ${attachments?.length ? attachments.map((a) => a.filename).join(", ") : "None"}\n` +
      `Text        : ${text || "(HTML only content)"}\n` +
      `Status      : Simulated (RESEND_API_KEY not configured)\n` +
      `--------------------------------------------------\n`,
    );
    return {
      success: true,
      provider: "dev_simulated",
      id: `sim_email_${Date.now()}`,
    };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: recipients,
        subject,
        html,
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }),
    });

    const data: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errorMsg = data?.message || data?.error || `HTTP ${res.status}`;
      console.error("[Resend API Error]:", errorMsg, data);

      if (isDevelopment) {
        console.warn("[Resend] Falling back to simulated mode in development");
        return {
          success: true,
          provider: "dev_simulated",
          id: `sim_fallback_${Date.now()}`,
          error: errorMsg,
        };
      }

      return {
        success: false,
        provider: "resend",
        error: errorMsg,
      };
    }

    return {
      success: true,
      provider: "resend",
      id: data.id,
    };
  } catch (err: any) {
    console.error("[Resend Network Exception]:", err);

    if (isDevelopment) {
      return {
        success: true,
        provider: "dev_simulated",
        id: `sim_error_${Date.now()}`,
        error: err.message,
      };
    }

    return {
      success: false,
      provider: "resend",
      error: err.message || "Failed to connect to Resend API",
    };
  }
}

// ─── 1. Email OTP Verification ──────────────────────────────────────────

export interface SendEmailOtpOptions {
  email: string;
  otp: string;
  apiKey?: string;
  fromEmail?: string;
  isDevelopment?: boolean;
}

export async function sendEmailOtp(options: SendEmailOtpOptions): Promise<SendEmailResult> {
  const { email, otp, apiKey, fromEmail, isDevelopment } = options;

  const subject = `${otp} is your Nepali Tales login code`;
  const text = `Namaste! Your Nepali Tales verification code is ${otp}. This code is valid for 10 minutes. If you did not request this code, please ignore this email.`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f7f7f8; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.06); border: 1px solid #e5e7eb;">
          
          <!-- Brand Header -->
          <tr>
            <td style="padding: 32px 32px 24px 32px; text-align: center; background: linear-gradient(135deg, #b91c1c 0%, #991b1b 100%);">
              <h1 style="margin: 0; font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">Nepali Tales</h1>
              <p style="margin: 6px 0 0 0; font-size: 13px; color: #fecaca; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">Authentic Nepali Cloud Kitchen</p>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding: 36px 32px 28px 32px; text-align: center;">
              <h2 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 700; color: #111827;">Verification Code</h2>
              <p style="margin: 0 0 28px 0; font-size: 15px; line-height: 22px; color: #4b5563;">
                Enter this 6-digit code on the checkout screen to verify your email and complete your order.
              </p>

              <!-- OTP Code Display -->
              <div style="background-color: #fef2f2; border: 2px dashed #f87171; border-radius: 12px; padding: 18px 24px; display: inline-block; margin-bottom: 24px;">
                <span style="font-family: 'SF Mono', Consolas, Monaco, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #b91c1c;">${otp}</span>
              </div>

              <p style="margin: 0; font-size: 13px; color: #6b7280;">
                Valid for <strong>10 minutes</strong>. Do not share this code with anyone.
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding: 0 32px;"><hr style="border: none; border-top: 1px solid #f3f4f6; margin: 0;" /></td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; text-align: center; font-size: 12px; color: #9ca3af; line-height: 18px;">
              If you didn't request this code, you can safely ignore this email.<br />
              Nepali Tales Cloud Kitchen • Kasarvadavali, Thane, Maharashtra
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  return sendEmail({
    to: email,
    subject,
    html,
    text,
    apiKey,
    from: fromEmail,
    isDevelopment,
  });
}

// ─── 2. Order Confirmation & Itemized Invoice ───────────────────────────

export interface SendOrderConfirmationOptions {
  order: OrderDoc;
  apiKey?: string;
  fromEmail?: string;
  adminEmail?: string;
  isDevelopment?: boolean;
}

export async function sendOrderConfirmationEmail(
  options: SendOrderConfirmationOptions,
): Promise<SendEmailResult> {
  const { order, apiKey, fromEmail, adminEmail, isDevelopment } = options;

  const customerEmail = order.customer?.email;
  const formattedCancelTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(order.canCustomerCancelUntil));

  const itemsListHtml = order.items
    .map((item) => {
      const addonRows = (item.addons || [])
        .map(
          (addon) => `
    <tr>
      <td style="padding: 8px 0 8px 16px; border-bottom: 1px solid #f3f4f6; font-size: 13px; color: #4b5563;">
        + ${addon.name}
      </td>
      <td style="padding: 8px 0; border-bottom: 1px solid #f3f4f6; font-size: 13px; color: #4b5563; text-align: center;">
        × ${addon.quantity}
      </td>
      <td style="padding: 8px 0; border-bottom: 1px solid #f3f4f6; font-size: 13px; font-weight: 600; color: #111827; text-align: right;">
        ₹${addon.subtotal}
      </td>
    </tr>`,
        )
        .join("");

      return `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; color: #1f2937;">
        <strong>${item.productName}</strong>
      </td>
      <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; color: #4b5563; text-align: center;">
        × ${item.quantity}
      </td>
      <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; font-weight: 600; color: #111827; text-align: right;">
        ₹${item.subtotal}
      </td>
    </tr>${addonRows}`;
    })
    .join("");

  const isPickup = (order.orderType || "delivery") === "pickup";
  const fulfillmentLabel = isPickup ? "Pickup" : "Delivery";
  const fulfillmentAddress = order.deliveryAddress.borzoFormat.address;

  const subject = `Order Confirmed: #${order.orderNumber} (₹${order.totalAmount}) - Nepali Tales`;
  const text =
    `Namaste ${order.customer.name}! Your ${fulfillmentLabel.toLowerCase()} order #${order.orderNumber} for ₹${order.totalAmount} is confirmed.\n` +
    `Items: ${order.items.map((i) => `${i.productName} x${i.quantity} (₹${i.subtotal})`).join(", ")}\n` +
    `${fulfillmentLabel}: ${fulfillmentAddress}\n` +
    `Cancellation Deadline: You can cancel before ${formattedCancelTime} if needed.\n` +
    `Thank you for ordering authentic Nepali food!`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f7f7f8; padding: 36px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06); border: 1px solid #e5e7eb;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 32px; background: linear-gradient(135deg, #15803d 0%, #166534 100%); text-align: center;">
              <span style="display: inline-block; background-color: rgba(255,255,255,0.2); color: #ffffff; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Order Confirmed</span>
              <h1 style="margin: 0; font-size: 26px; font-weight: 800; color: #ffffff;">Thank You, ${order.customer.name}!</h1>
              <p style="margin: 6px 0 0 0; font-size: 14px; color: #bbf7d0;">Order #${order.orderNumber} • Paid via Razorpay</p>
            </td>
          </tr>

          <!-- Summary Box -->
          <tr>
            <td style="padding: 24px 32px 16px 32px;">
              <div style="background-color: #fefce8; border: 1px solid #fef08a; border-radius: 10px; padding: 14px 16px; margin-bottom: 24px; font-size: 13px; color: #854d0e;">
                <strong>Cancellation Window:</strong> You can cancel this order with an instant refund before <strong>${formattedCancelTime}</strong>. Once our chefs begin cooking, orders cannot be cancelled.
              </div>

              <!-- Order Items Table -->
              <h3 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 700; color: #111827;">Your Dishes</h3>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                <thead>
                  <tr style="border-bottom: 2px solid #e5e7eb;">
                    <th align="left" style="padding-bottom: 8px; font-size: 12px; color: #6b7280; text-transform: uppercase;">Item</th>
                    <th align="center" style="padding-bottom: 8px; font-size: 12px; color: #6b7280; text-transform: uppercase;">Qty</th>
                    <th align="right" style="padding-bottom: 8px; font-size: 12px; color: #6b7280; text-transform: uppercase;">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsListHtml}
                </tbody>
              </table>

              <!-- Bill Totals -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px; background-color: #f9fafb; padding: 14px 16px; border-radius: 8px;">
                <tr>
                  <td style="padding: 4px 0; font-size: 13px; color: #6b7280;">Item Total</td>
                  <td align="right" style="padding: 4px 0; font-size: 13px; color: #1f2937;">₹${order.itemTotal}</td>
                </tr>
                ${order.deliveryFee > 0 ? `<tr>
                  <td style="padding: 4px 0; font-size: 13px; color: #6b7280;">Delivery Fee</td>
                  <td align="right" style="padding: 4px 0; font-size: 13px; color: #1f2937;">₹${order.deliveryFee}</td>
                </tr>` : `<tr>
                  <td style="padding: 4px 0; font-size: 13px; color: #6b7280;">Pickup</td>
                  <td align="right" style="padding: 4px 0; font-size: 13px; color: #15803d;">Free</td>
                </tr>`}
                <tr>
                  <td style="padding: 8px 0 0 0; font-size: 15px; font-weight: 700; color: #111827; border-top: 1px solid #e5e7eb;">Total Paid</td>
                  <td align="right" style="padding: 8px 0 0 0; font-size: 17px; font-weight: 800; color: #b91c1c; border-top: 1px solid #e5e7eb;">₹${order.totalAmount}</td>
                </tr>
              </table>

              <h3 style="margin: 0 0 8px 0; font-size: 15px; font-weight: 700; color: #111827;">${isPickup ? "Pickup Details" : "Delivery Details"}</h3>
              <p style="margin: 0 0 4px 0; font-size: 14px; line-height: 20px; color: #374151;">
                ${fulfillmentAddress}
              </p>
              ${order.deliveryAddress.borzoFormat.note ? `<p style="margin: 0 0 4px 0; font-size: 13px; color: #6b7280;">Note: ${order.deliveryAddress.borzoFormat.note}</p>` : ""}
              <p style="margin: 4px 0 0 0; font-size: 13px; color: #6b7280;">
                Slot: <strong>${order.dispatchSlot?.label || "Tomorrow Morning"}</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #fafafa; border-top: 1px solid #f3f4f6; text-align: center; font-size: 12px; color: #9ca3af; line-height: 18px;">
              Nepali Tales Cloud Kitchen • Kasarvadavali, Thane<br />
              Need help? Reach out on +91 7678097659
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  // Generate official itemized PDF invoice attachment
  let attachments: EmailAttachment[] | undefined;
  try {
    const pdfBytes = await generateOrderInvoicePdf(order);
    const base64Pdf = uint8ArrayToBase64(pdfBytes);
    attachments = [
      {
        filename: `Invoice_${order.orderNumber}.pdf`,
        content: base64Pdf,
      },
    ];
  } catch (pdfErr) {
    console.error("[Resend] Failed to generate PDF invoice attachment:", pdfErr);
  }

  // 1. Send confirmation to customer if email is provided (with invoice PDF attached)
  if (customerEmail) {
    await sendEmail({
      to: customerEmail,
      subject,
      html,
      text,
      apiKey,
      from: fromEmail,
      isDevelopment,
      attachments,
    });
  }

  // 2. Send notification to Kitchen Admin if configured (with invoice PDF attached)
  if (adminEmail && adminEmail !== customerEmail) {
    const adminSubject = `New Kitchen Order: #${order.orderNumber} (₹${order.totalAmount}) - ${order.customer.name}`;
    await sendEmail({
      to: adminEmail,
      subject: adminSubject,
      html,
      text,
      apiKey,
      from: fromEmail,
      isDevelopment,
      attachments,
    }).catch((e) => console.error("Failed to notify kitchen admin email:", e));
  }

  return {
    success: true,
    provider: apiKey ? "resend" : "dev_simulated",
  };
}

// ─── 3. Real-time Order Status Updates (Courier / Delivery) ─────────────

export interface SendOrderStatusEmailOptions {
  order: OrderDoc;
  status: OrderStatus;
  trackingUrl?: string;
  note?: string;
  apiKey?: string;
  fromEmail?: string;
  adminEmail?: string;
  isDevelopment?: boolean;
}

export async function sendOrderStatusEmail(
  options: SendOrderStatusEmailOptions,
): Promise<SendEmailResult> {
  const { order, status, trackingUrl, note, apiKey, fromEmail, adminEmail, isDevelopment } = options;
  const customerEmail = order.customer?.email;

  let statusTitle = "Order Status Updated";
  let statusBadge = "Update";
  let statusColor = "#2563eb"; // Blue
  let message = `Your order #${order.orderNumber} has been updated.`;

  switch (status) {
    case "preparing":
      statusTitle = "Cooking in Kitchen!";
      statusBadge = "Cooking Fresh";
      statusColor = "#d97706";
      message = "Our Nepali chefs have begun freshly preparing your authentic delicacies.";
      break;

    case "ready": {
      const isPickup = (order.orderType || "delivery") === "pickup";
      if (isPickup) {
        statusTitle = "Ready for Pickup!";
        statusBadge = "Ready";
        statusColor = "#4f46e5";
        message = `Your authentic Nepali delicacies are freshly prepared, packed, and ready for pickup at our kitchen! ${order.deliveryAddress?.borzoFormat?.note || ""}`.trim();
      } else {
        statusTitle = "Your Order is Ready!";
        statusBadge = "Packed & Ready";
        statusColor = "#16a34a";
        message = "Your authentic Nepali delicacies are freshly prepared and packed hot! Our kitchen team is dispatching your order for delivery.";
      }
      break;
    }

    case "porter_booked":
    case "out_for_delivery":
      statusTitle = "Out for Delivery!";
      statusBadge = "On The Way";
      statusColor = "#16a34a";
      message = "Your food is packed hot and our delivery courier is on the way to your doorstep!";
      break;

    case "delivered":
      statusTitle = "Delivered! Enjoy your meal";
      statusBadge = "Delivered";
      statusColor = "#15803d";
      message = "Your order has been delivered. We hope you love the taste of authentic Nepali cuisine!";
      break;

    case "cancelled_by_customer":
      statusTitle = "Order Cancelled & Refund Initiated";
      statusBadge = "Cancelled";
      statusColor = "#dc2626";
      message = `Your order #${order.orderNumber} has been cancelled per your request before kitchen preparation started. A full refund of ₹${order.totalAmount} has been initiated to your original payment method via Razorpay.`;
      break;

    case "cancelled_by_admin":
      statusTitle = "Order Cancelled & Refund Initiated";
      statusBadge = "Cancelled";
      statusColor = "#dc2626";
      message = `Your order #${order.orderNumber} has been cancelled by our kitchen team. ${note ? note : `A full refund of ₹${order.totalAmount} has been initiated to your original payment method via Razorpay.`}`;
      break;
  }

  const isCancelled = status === "cancelled_by_customer" || status === "cancelled_by_admin";

  const trackingButtonHtml = trackingUrl
    ? `
    <div style="margin: 28px 0; text-align: center;">
      <a href="${trackingUrl}" target="_blank" style="background-color: #16a34a; color: #ffffff; padding: 14px 28px; border-radius: 10px; font-size: 15px; font-weight: 700; text-decoration: none; display: inline-block; box-shadow: 0 4px 10px rgba(22, 163, 74, 0.3);">
        Track Delivery Rider Live
      </a>
    </div>
  `
    : "";

  const itemsSummaryHtml = order.items && order.items.length > 0
    ? `
      <div style="margin-top: 16px; border-top: 1px solid #e5e7eb; padding-top: 12px;">
        <p style="margin: 0 0 8px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; color: #6b7280; letter-spacing: 0.5px;">Items in this Order</p>
        <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: #374151; line-height: 20px;">
          ${order.items.map((i) => `<li><strong>${i.productName}</strong> × ${i.quantity} (₹${i.subtotal})</li>`).join("")}
        </ul>
      </div>
    `
    : "";

  const subject = `${statusTitle} - Order #${order.orderNumber}`;
  const text = `${statusTitle}\n\n${message}\n\nOrder #${order.orderNumber} (₹${order.totalAmount})\n${trackingUrl ? `Live Tracking: ${trackingUrl}\n` : ""}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f7f7f8; padding: 36px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06); border: 1px solid #e5e7eb;">
          
          <tr style="background-color: ${statusColor};">
            <td style="padding: 28px; text-align: center;">
              <span style="display: inline-block; background-color: rgba(255,255,255,0.25); color: #ffffff; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">${statusBadge}</span>
              <h1 style="margin: 0; font-size: 24px; font-weight: 800; color: #ffffff;">${statusTitle}</h1>
              <p style="margin: 6px 0 0 0; font-size: 14px; color: rgba(255,255,255,0.9);">Order #${order.orderNumber}</p>
            </td>
          </tr>

          <tr>
            <td style="padding: 32px 28px;">
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 24px; color: #374151;">
                ${message}
              </p>

              ${note && !isCancelled ? `<p style="margin: 0 0 16px 0; font-size: 14px; color: #6b7280; font-style: italic;">"${note}"</p>` : ""}

              ${trackingButtonHtml}

              <div style="background-color: #f9fafb; border-radius: 10px; padding: 14px 16px; border: 1px solid #f3f4f6; margin-top: 20px;">
                <p style="margin: 0 0 4px 0; font-size: 13px; color: #6b7280;">${(order.orderType || "delivery") === "pickup" ? "Pickup at Kitchen:" : "Delivering to:"}</p>
                <p style="margin: 0; font-size: 14px; font-weight: 600; color: #111827;">${(order.orderType || "delivery") === "pickup" ? "Metropolis Riveria, Kasarvadavali, Thane" : (order.deliveryAddress?.street || order.deliveryAddress?.borzoFormat?.address || "Thane, Maharashtra")}</p>
                <p style="margin: 6px 0 0 0; font-size: 12px; color: #6b7280;">Scheduled Slot: <strong>${order.dispatchDate || ""} (${order.dispatchSlot?.label || "Scheduled"})</strong></p>
                <p style="margin: 2px 0 0 0; font-size: 12px; color: #6b7280;">Total Amount: <strong>₹${order.totalAmount}</strong></p>
              </div>

              ${itemsSummaryHtml}
            </td>
          </tr>

          <tr>
            <td style="padding: 20px 28px; background-color: #fafafa; border-top: 1px solid #f3f4f6; text-align: center; font-size: 12px; color: #9ca3af;">
              Nepali Tales Cloud Kitchen • Kasarvadavali, Thane • +91 7678097659
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  // 1. Send update/cancellation notice to customer
  let customerSendResult: SendEmailResult = {
    success: true,
    provider: apiKey ? "resend" : "dev_simulated",
  };

  if (customerEmail) {
    customerSendResult = await sendEmail({
      to: customerEmail,
      subject,
      html,
      text,
      apiKey,
      from: fromEmail,
      isDevelopment,
    });
  }

  // 2. When an order is cancelled, notify Kitchen Admin so chefs do NOT prepare or dispatch it
  if (isCancelled && adminEmail) {
    const cancelSource = status === "cancelled_by_customer" ? "Customer" : "Kitchen Admin";
    const adminSubject = `[Kitchen Alert] Order #${order.orderNumber} Cancelled (${cancelSource}) - Nepali Tales`;
    const adminText = `[KITCHEN ALERT] Order #${order.orderNumber} has been cancelled by ${cancelSource}.\n\n` +
      `DO NOT PREPARE OR DISPATCH THIS ORDER.\n\n` +
      `Customer: ${order.customer.name} (${order.customer.phone || "No phone"})\n` +
      `Scheduled Date/Slot: ${order.dispatchDate || ""} ${order.dispatchSlot?.label || ""}\n` +
      `Fulfillment: ${(order.orderType || "delivery").toUpperCase()}\n` +
      `Refund: Full refund of ₹${order.totalAmount} initiated via Razorpay.\n` +
      `Items: ${(order.items || []).map((i) => `${i.productName} x${i.quantity}`).join(", ")}\n`;

    const adminHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${adminSubject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding: 36px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06); border: 2px solid #ef4444;">
          
          <tr style="background-color: #dc2626;">
            <td style="padding: 24px; text-align: center;">
              <span style="display: inline-block; background-color: rgba(255,255,255,0.25); color: #ffffff; padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Kitchen Alert</span>
              <h1 style="margin: 0; font-size: 22px; font-weight: 800; color: #ffffff;">Order #${order.orderNumber} Cancelled</h1>
              <p style="margin: 6px 0 0 0; font-size: 14px; color: #fee2e2;">Cancelled by ${cancelSource}</p>
            </td>
          </tr>

          <tr>
            <td style="padding: 28px 24px;">
              <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px;">
                <p style="margin: 0; font-size: 14px; font-weight: 700; color: #991b1b;">
                  ATTENTION: DO NOT PREPARE OR DISPATCH THIS ORDER.
                </p>
                <p style="margin: 6px 0 0 0; font-size: 13px; color: #7f1d1d;">
                  A full refund of ₹${order.totalAmount} has been initiated to the customer via Razorpay.
                </p>
              </div>

              <div style="background-color: #f9fafb; border-radius: 10px; padding: 14px 16px; border: 1px solid #f3f4f6; margin-bottom: 20px; font-size: 13px;">
                <p style="margin: 0 0 6px 0;"><strong>Customer:</strong> ${order.customer.name} (${order.customer.phone || "No phone"})</p>
                <p style="margin: 0 0 6px 0;"><strong>Customer Email:</strong> ${order.customer.email || "N/A"}</p>
                <p style="margin: 0 0 6px 0;"><strong>Scheduled Slot:</strong> ${order.dispatchDate || ""} (${order.dispatchSlot?.label || "Slot"})</p>
                <p style="margin: 0 0 6px 0;"><strong>Fulfillment:</strong> ${(order.orderType || "delivery").toUpperCase()}</p>
                <p style="margin: 0;"><strong>Address:</strong> ${(order.orderType || "delivery") === "pickup" ? "Kitchen Pickup" : (order.deliveryAddress?.street || order.deliveryAddress?.borzoFormat?.address || "Delivery Address")}</p>
              </div>

              ${itemsSummaryHtml}
            </td>
          </tr>

          <tr>
            <td style="padding: 16px 24px; background-color: #fafafa; border-top: 1px solid #f3f4f6; text-align: center; font-size: 12px; color: #9ca3af;">
              Nepali Tales Kitchen Order Management
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    await sendEmail({
      to: adminEmail,
      subject: adminSubject,
      html: adminHtml,
      text: adminText,
      apiKey,
      from: fromEmail,
      isDevelopment,
    }).catch((e) => console.error("Failed to send cancellation alert to kitchen admin:", e));
  }

  return customerSendResult;
}
