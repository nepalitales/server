import crypto from "node:crypto";
import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import type { AdminPushSubscriptionDoc } from "../types";

// Standard P-256 VAPID Keypair (Configurable via Cloudflare Worker env secrets)
export const DEFAULT_VAPID_PUBLIC_KEY =
  "BBoommxqSZpuv8Kjgj4oPCzPBxkRossBc6dSBRKb0UWvk9F7LeyvpPq1VdZzdLdo3N3imc8z2IfCS8EYRb8MbQ8";
export const DEFAULT_VAPID_PRIVATE_KEY =
  "_5otQFJxx4sZVwb7jPzNesq3XxvPmIDwQsfiI3xau88";
export const DEFAULT_VAPID_SUBJECT = "mailto:admin@nepalitales.com";

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  orderId?: string;
  orderNumber?: string;
  tag?: string;
  badge?: string;
  icon?: string;
  timestamp?: number;
}

function base64UrlToBuffer(b64url: string): Buffer {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64");
}

function bufferToBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Creates an ES256 VAPID Authorization header JWT for the push service.
 */
function createVapidAuthHeader(
  endpoint: string,
  publicKeyB64Url: string,
  privateKeyB64Url: string,
  subject: string,
): string {
  const parsedUrl = new URL(endpoint);
  const audience = `${parsedUrl.protocol}//${parsedUrl.host}`;

  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // 12 hours
    sub: subject,
  };

  const headerB64 = bufferToBase64Url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = bufferToBase64Url(Buffer.from(JSON.stringify(payload)));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  // Uncompressed public key (65 bytes): 0x04 + x (32 bytes) + y (32 bytes)
  const pubBuf = base64UrlToBuffer(publicKeyB64Url);
  const x = bufferToBase64Url(pubBuf.subarray(1, 33));
  const y = bufferToBase64Url(pubBuf.subarray(33, 65));

  const privKey = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x,
      y,
      d: privateKeyB64Url,
    },
    format: "jwk",
  });

  const signer = crypto.createSign("SHA256");
  signer.update(unsignedToken);
  const signature = signer.sign({ key: privKey, dsaEncoding: "ieee-p1363" });
  const sigB64 = bufferToBase64Url(signature);

  const jwt = `${unsignedToken}.${sigB64}`;
  return `vapid t=${jwt}, k=${publicKeyB64Url}`;
}

/**
 * Encrypts a push payload using RFC 8291 (Message Encryption for Web Push: aes128gcm).
 */
function encryptPayload(
  payloadText: string,
  clientPubKeyB64Url: string,
  clientAuthB64Url: string,
): Buffer {
  const clientPubKey = base64UrlToBuffer(clientPubKeyB64Url);
  const clientAuth = base64UrlToBuffer(clientAuthB64Url);

  const localECDH = crypto.createECDH("prime256v1");
  localECDH.generateKeys();
  const localPubKey = localECDH.getPublicKey();

  const sharedSecret = localECDH.computeSecret(clientPubKey);
  const salt = crypto.randomBytes(16);

  // RFC 8291 Section 3.2
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    clientPubKey,
    localPubKey,
  ]);
  const ikm = crypto.hkdfSync("sha256", sharedSecret, clientAuth, keyInfo, 32);

  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
  const cek = crypto.hkdfSync("sha256", Buffer.from(ikm), salt, cekInfo, 16);

  const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "utf8");
  const nonce = crypto.hkdfSync("sha256", Buffer.from(ikm), salt, nonceInfo, 12);

  // Payload record padding: content + 0x02 delimiter
  const plaintext = Buffer.concat([
    Buffer.from(payloadText, "utf8"),
    Buffer.from([2]),
  ]);

  const cipher = crypto.createCipheriv("aes-128-gcm", Buffer.from(cek), Buffer.from(nonce));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Header: salt (16 bytes) + record_size (4 bytes = 4096) + idlen (1 byte) + keyid (65 bytes)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);

  const header = Buffer.concat([
    salt,
    rs,
    Buffer.from([localPubKey.length]),
    localPubKey,
  ]);

  return Buffer.concat([header, encrypted, tag]);
}

/**
 * Sends a single Web Push notification to a subscription.
 * Returns true if successful, or false if subscription expired/failed.
 */
export async function sendWebPush(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: PushPayload,
  env?: {
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    VAPID_SUBJECT?: string;
  },
): Promise<{ success: boolean; statusCode?: number; isExpired?: boolean }> {
  try {
    const pubKey = env?.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;
    const privKey = env?.VAPID_PRIVATE_KEY || DEFAULT_VAPID_PRIVATE_KEY;
    const subject = env?.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;

    const authHeader = createVapidAuthHeader(
      subscription.endpoint,
      pubKey,
      privKey,
      subject,
    );

    const encryptedBody = encryptPayload(
      JSON.stringify(payload),
      subscription.keys.p256dh,
      subscription.keys.auth,
    );

    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400", // 24 hours
        Urgency: "high", // immediate wake up on mobile devices
      },
      body: encryptedBody as unknown as BodyInit,
    });

    if (response.status === 201 || response.status === 200 || response.status === 202) {
      return { success: true, statusCode: response.status };
    }

    // 404 Not Found or 410 Gone indicates the push subscription has expired/unregistered
    const isExpired = response.status === 404 || response.status === 410;
    return { success: false, statusCode: response.status, isExpired };
  } catch (error) {
    console.error("[WebPush]: Failed to deliver push notification:", error);
    return { success: false };
  }
}

/**
 * Broadcasts a Web Push notification to all subscribed admin devices.
 * Automatically cleans up expired subscriptions.
 */
export async function broadcastPushToAdmins(
  db: Db,
  env: {
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    VAPID_SUBJECT?: string;
  } | undefined,
  payload: PushPayload,
): Promise<{ sent: number; total: number }> {
  try {
    const collection = db.collection<AdminPushSubscriptionDoc>(
      COLLECTIONS.ADMIN_PUSH_SUBSCRIPTIONS,
    );
    const subscriptions = await collection.find({}).toArray();

    if (subscriptions.length === 0) {
      return { sent: 0, total: 0 };
    }

    const expiredEndpoints: string[] = [];
    let sentCount = 0;

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const result = await sendWebPush(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
          env,
        );

        if (result.success) {
          sentCount++;
        } else if (result.isExpired) {
          expiredEndpoints.push(sub.endpoint);
        }
      }),
    );

    // Prune expired subscriptions
    if (expiredEndpoints.length > 0) {
      await collection.deleteMany({
        endpoint: { $in: expiredEndpoints },
      }).catch((e) => console.error("[WebPush]: Failed to prune expired subscriptions:", e));
    }

    return { sent: sentCount, total: subscriptions.length };
  } catch (error) {
    console.error("[WebPush]: broadcastPushToAdmins error:", error);
    return { sent: 0, total: 0 };
  }
}
