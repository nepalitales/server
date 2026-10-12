import { MongoClient } from "mongodb";
import { loadEnv } from "./load-env";

loadEnv();

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "nepali-tales";

export async function ensureIndexes() {
  console.log("Connecting to MongoDB Atlas to ensure all production indexes...");
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB_NAME);

  try {
    console.log("Creating client_users indexes...");
    await db.collection("client_users").createIndex({ id: 1 }, { unique: true });
    await db.collection("client_users").createIndex({ email: 1 }, { unique: true, sparse: true });
    await db.collection("client_users").createIndex({ phone: 1 }, { sparse: true });

    console.log("Creating client_sessions indexes & TTL auto-purge...");
    await db.collection("client_sessions").createIndex({ token: 1 }, { unique: true });
    await db.collection("client_sessions").createIndex({ userId: 1 });
    await db.collection("client_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    console.log("Creating client_otps indexes & TTL auto-purge...");
    await db.collection("client_otps").createIndex({ identifier: 1 });
    await db.collection("client_otps").createIndex({ lastIp: 1, createdAt: 1 });
    await db.collection("client_otps").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    console.log("Creating client_addresses indexes...");
    await db.collection("client_addresses").createIndex({ id: 1 }, { unique: true });
    await db.collection("client_addresses").createIndex({ userId: 1 });

    console.log("Creating orders indexes...");
    await db.collection("orders").createIndex({ id: 1 }, { unique: true });
    await db.collection("orders").createIndex({ orderNumber: 1 }, { unique: true });
    await db.collection("orders").createIndex({ "payment.razorpayOrderId": 1 });
    await db.collection("orders").createIndex({ status: 1 });
    await db.collection("orders").createIndex({ createdAt: -1 });
    await db.collection("orders").createIndex({ userId: 1, createdAt: -1 });
    await db.collection("orders").createIndex({ "customer.phone": 1 });
    await db.collection("orders").createIndex({ dispatchDate: 1, "dispatchSlot.id": 1 });
    await db.collection("orders").createIndex({ orderType: 1, status: 1 });
    await db.collection("orders").createIndex({ status: 1, canCustomerCancelUntil: 1 });

    console.log("Creating order_events indexes...");
    await db.collection("order_events").createIndex({ timestamp: 1 });
    await db.collection("order_events").createIndex({ orderId: 1 });

    console.log("Creating dispatch_slot_buckets indexes...");
    await db.collection("dispatch_slot_buckets").createIndex({ date: 1 });
    await db.collection("dispatch_slot_buckets").createIndex({ date: 1, slotId: 1 });

    console.log("Creating products and categories indexes...");
    await db.collection("products").createIndex({ id: 1 }, { unique: true });
    await db.collection("products").createIndex({ categoryId: 1 });
    await db.collection("products").createIndex({ categorySlug: 1, name: 1 });
    await db.collection("products").createIndex({ isAvailable: 1 });
    await db.collection("products").createIndex({ isAvailable: 1, categorySlug: 1 });
    await db.collection("categories").createIndex({ id: 1 }, { unique: true });
    await db.collection("categories").createIndex({ slug: 1 }, { unique: true });
    await db.collection("categories").createIndex({ displayOrder: 1 });

    console.log("Creating admin authentication & session indexes...");
    await db.collection("admins").createIndex({ id: 1 }, { unique: true });
    await db.collection("admins").createIndex({ email: 1 }, { unique: true });
    await db.collection("admins").createIndex({ phone: 1 }, { unique: true });
    await db.collection("sessions").createIndex({ token: 1 }, { unique: true });
    await db.collection("sessions").createIndex({ adminId: 1 });
    await db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    console.log("Creating addons, settings, holidays, and faqs indexes...");
    await db.collection("addons").createIndex({ id: 1 }, { unique: true });
    await db.collection("addons").createIndex({ isAvailable: 1, displayOrder: 1, name: 1 });
    await db.collection("order_settings").createIndex({ docId: 1 }, { unique: true });
    await db.collection("order_windows").createIndex({ day: 1 }, { unique: true });
    await db.collection("dispatch_windows").createIndex({ day: 1 }, { unique: true });
    await db.collection("holidays").createIndex({ id: 1 }, { unique: true });
    await db.collection("holidays").createIndex({ date: 1 }, { unique: true });
    await db.collection("faqs").createIndex({ id: 1 }, { unique: true });
    await db.collection("faqs").createIndex({ isActive: 1, displayOrder: 1 });
    await db.collection("faqs").createIndex({ category: 1 });

    console.log("[SUCCESS] All production indexes verified and created successfully!");
  } catch (error) {
    console.error("[FAILED] Error ensuring indexes:", error);
    throw error;
  } finally {
    await client.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureIndexes()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
