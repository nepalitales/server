import { timingSafeEqual } from "node:crypto";

/**
 * Cryptographic utilities for password hashing and session tokens.
 *
 * Uses Web Crypto API for PBKDF2 key derivation and native Buffer/crypto
 * primitives for encoding and constant-time comparisons.
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Hash a password using PBKDF2-SHA256 with a random salt.
 * Returns `salt:hash` as hex strings separated by colon.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LENGTH * 8,
  );

  const hashHex = Buffer.from(derivedBits).toString("hex");
  const saltHex = Buffer.from(salt).toString("hex");

  return `${saltHex}:${hashHex}`;
}

/**
 * Verify a password against a stored `salt:hash` string.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltHex, storedHashHex] = stored.split(":");
  if (!saltHex || !storedHashHex) return false;

  const salt = Buffer.from(saltHex, "hex");

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LENGTH * 8,
  );

  const computedBuffer = Buffer.from(derivedBits);
  const storedBuffer = Buffer.from(storedHashHex, "hex");

  if (computedBuffer.length !== storedBuffer.length) {
    return false;
  }

  return timingSafeEqual(computedBuffer, storedBuffer);
}

/**
 * Generate a cryptographically secure session token.
 */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("hex");
}

/**
 * Generate a short unique ID (for products, holidays, etc.).
 */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.getRandomValues(new Uint8Array(6));
  const randomStr = Buffer.from(random).toString("hex").slice(0, 8);
  return `${prefix}_${timestamp}${randomStr}`;
}
