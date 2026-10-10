/**
 * WhatsApp Cloud API Client and OTP utilities.
 *
 * Implements Meta WhatsApp Business Cloud API integration for sending OTPs
 * via WhatsApp Direct Message.
 *
 * In development or when credentials are not yet configured,
 * it safely logs the OTP to the console so frontend & backend testing
 * can proceed without blocking on Meta Business verification.
 */

/**
 * Standardize phone number for WhatsApp E.164 without leading '+':
 * - 10 digits (India) -> prepend '91' (e.g. 9876543210 -> 919876543210)
 * - 11 digits starting with 0 -> replace 0 with '91'
 * - 12 digits starting with 91 -> keep as is
 * - Other international numbers -> keep digits only
 */
export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");

  // 10-digit Indian mobile number
  if (digits.length === 10) {
    return `91${digits}`;
  }

  // 11-digit starting with 0
  if (digits.length === 11 && digits.startsWith("0")) {
    return `91${digits.slice(1)}`;
  }

  return digits;
}

/**
 * Generate a cryptographically secure random N-digit numeric OTP.
 */
export function generateNumericOtp(length = 6): string {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  const range = max - min + 1;

  const randomBuffer = new Uint32Array(1);
  crypto.getRandomValues(randomBuffer);
  const randomNum = min + (randomBuffer[0]! % range);

  return randomNum.toString().padStart(length, "0");
}

/**
 * Hash an OTP using SHA-256 for secure storage in MongoDB.
 */
export async function hashOtp(otp: string): Promise<string> {
  const data = new TextEncoder().encode(otp);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

/**
 * Verify a plain OTP against a stored SHA-256 hash.
 */
export async function verifyOtp(plainOtp: string, storedHash: string): Promise<boolean> {
  const calculatedHash = await hashOtp(plainOtp);
  return calculatedHash.toLowerCase() === storedHash.toLowerCase();
}

export interface SendWhatsAppOtpOptions {
  phone: string;
  otp: string;
  apiToken?: string;
  phoneNumberId?: string;
  templateName?: string;
  isDevelopment?: boolean;
}

export interface SendWhatsAppOtpResult {
  success: boolean;
  provider: "meta_whatsapp" | "dev_simulated";
  messageId?: string;
  error?: string;
}

/**
 * Send an OTP via WhatsApp Cloud API (or simulator in dev mode).
 */
export async function sendWhatsAppOtp(
  options: SendWhatsAppOtpOptions,
): Promise<SendWhatsAppOtpResult> {
  const { phone, otp, apiToken, phoneNumberId, templateName, isDevelopment } = options;
  const normalizedPhone = normalizePhoneNumber(phone);

  // If credentials are not configured or in development mode without token, simulate
  if (!apiToken || !phoneNumberId) {
    console.log(
      `\n--------------------------------------------------\n` +
      `[WhatsApp OTP Simulator]\n` +
      `Recipient : +${normalizedPhone}\n` +
      `OTP Code  : ${otp}\n` +
      `Message   : "Your Nepali Tales verification code is: ${otp}. Valid for 10 minutes."\n` +
      `Status    : Simulated (credentials not provided)\n` +
      `--------------------------------------------------\n`
    );

    return {
      success: true,
      provider: "dev_simulated",
      messageId: `sim_${Date.now()}`,
    };
  }

  // Meta WhatsApp Cloud API endpoint
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  // Payload: If pre-approved template name is provided, use template.
  // Otherwise, use direct text message.
  let payload: Record<string, unknown>;

  if (templateName) {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizedPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: otp,
              },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              {
                type: "text",
                text: otp,
              },
            ],
          },
        ],
      },
    };
  } else {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizedPhone,
      type: "text",
      text: {
        preview_url: false,
        body: `Your Nepali Tales verification code is: ${otp}. Valid for 10 minutes. Please do not share this code with anyone.`,
      },
    };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as any;

    if (!res.ok) {
      const errMsg = data?.error?.message || `Meta WhatsApp API error: ${res.status}`;
      console.error("Meta WhatsApp Cloud API error:", data);

      // In development, fall back gracefully so testing does not break
      if (isDevelopment) {
        console.warn(`[WhatsApp API Fallback to Dev Simulator due to error: ${errMsg}]`);
        return {
          success: true,
          provider: "dev_simulated",
          error: errMsg,
        };
      }

      return {
        success: false,
        provider: "meta_whatsapp",
        error: errMsg,
      };
    }

    const messageId = data?.messages?.[0]?.id;
    return {
      success: true,
      provider: "meta_whatsapp",
      messageId,
    };
  } catch (error: any) {
    console.error("Failed to send WhatsApp message:", error);

    if (isDevelopment) {
      return {
        success: true,
        provider: "dev_simulated",
        error: error.message,
      };
    }

    return {
      success: false,
      provider: "meta_whatsapp",
      error: error.message,
    };
  }
}
