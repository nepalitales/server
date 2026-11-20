import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { authMiddleware } from "../../middleware/auth";
import { COLLECTIONS } from "../../lib/db";
import {
  DEFAULT_VAPID_PUBLIC_KEY,
  sendWebPush,
  broadcastPushToAdmins,
} from "../../lib/web-push";
import type { AdminPushSubscriptionDoc } from "../../types";

export const adminPushRoutes = new Hono<AppBindings>();

adminPushRoutes.use("*", authMiddleware);

/**
 * Returns the VAPID public key needed for the browser's PushManager subscription.
 */
adminPushRoutes.get("/vapid-public-key", (c) => {
  const publicKey = c.env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;
  return c.json({
    success: true,
    publicKey,
  });
});

/**
 * Registers or updates a Web Push subscription for an admin device.
 */
adminPushRoutes.post("/subscribe", async (c) => {
  const db = c.get("db");
  const adminId = c.get("adminId");
  const body = await c.req.json().catch(() => null);

  if (!body || !body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json(
      { success: false, message: "Invalid push subscription object" },
      400,
    );
  }

  const userAgent = c.req.header("user-agent") || body.userAgent;

  // Retrieve admin details if available
  let adminEmail: string | undefined;
  if (adminId) {
    const admin = await db
      .collection(COLLECTIONS.ADMINS)
      .findOne({ id: adminId });
    if (admin) {
      adminEmail = (admin as any).email;
    }
  }

  const collection = db.collection<AdminPushSubscriptionDoc>(
    COLLECTIONS.ADMIN_PUSH_SUBSCRIPTIONS,
  );

  await collection.updateOne(
    { endpoint: body.endpoint },
    {
      $set: {
        endpoint: body.endpoint,
        keys: {
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
        },
        adminId,
        adminEmail,
        userAgent,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );

  return c.json({
    success: true,
    message: "Admin push notifications enabled for this device",
  });
});

/**
 * Unsubscribes a device from admin push notifications.
 */
adminPushRoutes.post("/unsubscribe", async (c) => {
  const db = c.get("db");
  const body = await c.req.json().catch(() => null);

  if (!body?.endpoint) {
    return c.json({ success: false, message: "Endpoint required" }, 400);
  }

  const collection = db.collection<AdminPushSubscriptionDoc>(
    COLLECTIONS.ADMIN_PUSH_SUBSCRIPTIONS,
  );
  await collection.deleteOne({ endpoint: body.endpoint });

  return c.json({
    success: true,
    message: "Device unsubscribed from push notifications",
  });
});

/**
 * Sends a test push notification to verify sound and delivery on this admin device.
 */
adminPushRoutes.post("/test", async (c) => {
  const db = c.get("db");
  const adminId = c.get("adminId");
  const body = await c.req.json().catch(() => ({}));

  const payload = {
    title: "🔔 Nepali Tales Test Order Alert",
    body: "Push notifications are working! You will be notified when a new order arrives.",
    url: "/orders",
    orderNumber: "TEST-999",
    timestamp: Date.now(),
  };

  if (body?.endpoint && body?.keys?.p256dh && body?.keys?.auth) {
    // Send to specific device if passed
    const res = await sendWebPush(
      { endpoint: body.endpoint, keys: body.keys },
      payload,
      c.env,
    );
    return c.json({
      success: res.success,
      message: res.success
        ? "Test notification sent successfully"
        : "Failed to deliver test notification to this device",
    });
  }

  // Otherwise broadcast test to all devices of this admin
  const collection = db.collection<AdminPushSubscriptionDoc>(
    COLLECTIONS.ADMIN_PUSH_SUBSCRIPTIONS,
  );
  const subs = await collection.find({ adminId }).toArray();

  if (subs.length === 0) {
    return c.json(
      {
        success: false,
        message: "No registered push devices found for this admin account",
      },
      404,
    );
  }

  let sent = 0;
  for (const sub of subs) {
    const res = await sendWebPush(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
      c.env,
    );
    if (res.success) sent++;
  }

  return c.json({
    success: sent > 0,
    message: `Test notification sent to ${sent} of ${subs.length} devices`,
  });
});
