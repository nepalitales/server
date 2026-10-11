/**
 * Email OTP helpers (hashing / generation).
 * Customer login is Resend email only - no WhatsApp OTP.
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

export async function hashOtp(otp: string): Promise<string> {
  const data = new TextEncoder().encode(otp);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

export async function verifyOtp(plainOtp: string, storedHash: string): Promise<boolean> {
  const calculatedHash = await hashOtp(otpNormalize(plainOtp));
  return calculatedHash.toLowerCase() === storedHash.toLowerCase();
}

function otpNormalize(otp: string): string {
  return otp.trim();
}
