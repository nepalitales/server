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
 * Opens a fresh MongoClient per request and closes it when the response completes.
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

  try {
    await next();
  } finally {
    await client.close().catch(() => {});
  }
}
