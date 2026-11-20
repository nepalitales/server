import { MongoClient, type Db, type Collection, type Document } from "mongodb";

/**
 * MongoDB connection for Cloudflare Workers.
 *
 * Cloudflare Workers have a unique execution model:
 * - Each request gets a fresh execution context
 * - Cloudflare strictly forbids cross-request promise resolution (promises/TCP sockets
 *   created in one request context cannot be resolved in another, otherwise the runtime
 *   cancels the request as hung).
 *
 * To avoid cross-request promise cancellation and poisoned sockets,
 * we create a lightweight MongoClient per request (maxPoolSize: 1) and close it in finally.
 *
 * Pattern: connect -> query -> close in finally.
 */

export async function getDb(uri: string, dbName: string): Promise<{ db: Db; client: MongoClient }> {
  const client = new MongoClient(uri, {
    maxPoolSize: 1,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
    serverSelectionTimeoutMS: 10_000,
    retryWrites: true,
    retryReads: true,
    w: "majority",
  } as any);

  await client.connect();
  const db = client.db(dbName);

  return { db, client };
}

/** Collection names as constants to avoid typos */
export const COLLECTIONS = {
  ADMINS: "admins",
  SESSIONS: "sessions",
  PRODUCTS: "products",
  CATEGORIES: "categories",
  ORDER_WINDOWS: "order_windows",
  WEEKLY_OFF: "weekly_off",
  HOLIDAYS: "holidays",
  CONFIG_VERSION: "config_version",
  CLIENT_USERS: "client_users",
  CLIENT_SESSIONS: "client_sessions",
  CLIENT_OTPS: "client_otps",
  CLIENT_ADDRESSES: "client_addresses",
  ORDERS: "orders",
  ORDER_EVENTS: "order_events",
  FAQS: "faqs",
  DISPATCH_WINDOWS: "dispatch_windows",
  DISPATCH_SLOT_BUCKETS: "dispatch_slot_buckets",
  ADDONS: "addons",
  ORDER_SETTINGS: "order_settings",
} as const;

