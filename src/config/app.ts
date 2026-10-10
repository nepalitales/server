import type { Context, Next } from "hono";
import type { MongoClient, Db } from "mongodb";
import type { Env } from "./env";
import { getDb } from "../lib/db";

import type { ClientUserDoc } from "../types";

/**
 * Hono bindings -- Cloudflare Worker env vars + app-level variables.
 *
 * `Bindings` = Cloudflare env vars injected per-request.
 * `Variables` = Request-scoped state set by middleware.
 */
export type AppBindings = {
  Bindings: Env;
  Variables: {
    adminId?: string;
    userId?: string;
    user?: ClientUserDoc;
    db: Db;
    dbClient: MongoClient;
  };
};

/**
 * Database connection middleware.
 *
 * Opens a fresh MongoClient per request.
 * For standard JSON endpoints: closes the connection in finally when the response completes.
 * For SSE streaming endpoints: leaves the connection open during the stream lifecycle,
 * and allows the streaming handler's finally block to close the client when the stream finishes.
 */
export async function dbMiddleware(
  c: Context<AppBindings>,
  next: Next,
): Promise<Response | void> {
  let db;
  let client;

  try {
    const res = await getDb(c.env.MONGODB_URI, c.env.MONGODB_DB_NAME);
    db = res.db;
    client = res.client;
  } catch (err) {
    console.error("[Database Connection Error]:", err);
    return c.json(
      {
        success: false,
        message: "Database service temporarily unavailable. Please try again shortly.",
      },
      503,
    );
  }

  c.set("db", db);
  c.set("dbClient", client);

  let isStream = false;

  try {
    await next();
    const contentType = c.res?.headers?.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      isStream = true;
    }
  } finally {
    if (!isStream) {
      await client.close().catch(() => {});
    }
  }
}
