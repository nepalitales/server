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
    await db.collection("orders").createIndex({ userId: 1, createdAt: -1 });

    console.log("Creating product compound indexes...");
    await db.collection("products").createIndex({ isAvailable: 1, categorySlug: 1 });

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
