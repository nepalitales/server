import { timingSafeEqual } from "node:crypto";

/**
 * Email OTP helpers (cryptographic hashing / generation / verification).
 * Customer login uses email verification via Resend.
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
 * Hash an OTP using SHA-256 with a unique random cryptographic salt and
 * optional identifier binding (email) to prevent precomputed rainbow table attacks.
 * Returns `${saltHex}:${hashHex}`.
 */
export async function hashOtp(otp: string, identifier?: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Buffer.from(salt).toString("hex");

  const message = identifier
    ? `${saltHex}:${identifier.toLowerCase().trim()}:${otpNormalize(otp)}`
    : `${saltHex}:${otpNormalize(otp)}`;

  const data = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hashHex = Buffer.from(digest).toString("hex");

  return `${saltHex}:${hashHex}`;
}

/**
 * Verifies an OTP against a stored hash using constant-time comparison (timingSafeEqual).
 * Supports both salted hashes (`salt:hash`) and legacy unsalted hashes for zero downtime.
 */
export async function verifyOtp(
  plainOtp: string,
  storedHash: string,
  identifier?: string,
): Promise<boolean> {
  const cleanOtp = otpNormalize(plainOtp);

  // Modern salted hash verification: salt:hash
  if (storedHash.includes(":")) {
    const [saltHex, expectedHashHex] = storedHash.split(":");
    if (!saltHex || !expectedHashHex) return false;

    const message = identifier
      ? `${saltHex}:${identifier.toLowerCase().trim()}:${cleanOtp}`
      : `${saltHex}:${cleanOtp}`;

    const data = new TextEncoder().encode(message);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const calculatedHashHex = Buffer.from(digest).toString("hex");

    const calculatedBuf = Buffer.from(calculatedHashHex, "hex");
    const expectedBuf = Buffer.from(expectedHashHex, "hex");

    if (calculatedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(calculatedBuf, expectedBuf);
  }

  // Backward compatibility fallback for legacy unsalted hashes (with constant-time comparison)
  const legacyData = new TextEncoder().encode(cleanOtp);
  const legacyDigest = await crypto.subtle.digest("SHA-256", legacyData);
  const legacyHashHex = Buffer.from(legacyDigest).toString("hex");

  const calcBuf = Buffer.from(legacyHashHex, "hex");
  const expBuf = Buffer.from(storedHash, "hex");

  if (calcBuf.length !== expBuf.length) return false;
  return timingSafeEqual(calcBuf, expBuf);
}

function otpNormalize(otp: string): string {
  return otp.trim();
}
