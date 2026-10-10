import type { Db } from "mongodb";
import type { AddonDoc } from "../types";
import { COLLECTIONS } from "./db";

/**
 * Isolate-level cache for add-ons.
 *
 * Cloudflare Workers cannot share Mongo connections across requests,
 * so we keep the (small) add-on catalog in isolate memory and also
 * write GET responses into the Cache API when available. Mutations
 * invalidate both layers so admin edits show up quickly.
 */

const MEMORY_TTL_MS = 5 * 60 * 1000;
const CACHE_URL = "https://nepali-tales.internal/addons";

export type AddonPublic = Omit<AddonDoc, "_id" | "imagePublicId">;

type CacheBucket = {
  items: AddonPublic[];
  expiresAt: number;
};

let memoryAll: CacheBucket | null = null;
let memoryAvailable: CacheBucket | null = null;
let indexesEnsured = false;

export async function ensureAddonIndexes(db: Db): Promise<void> {
  if (indexesEnsured) return;
  const addons = db.collection(COLLECTIONS.ADDONS);
  await Promise.all([
    addons.createIndex({ id: 1 }, { unique: true }),
    addons.createIndex({ isAvailable: 1, displayOrder: 1, name: 1 }),
  ]);
  indexesEnsured = true;
}

function toPublic(doc: AddonDoc): AddonPublic {
  return {
    id: doc.id,
    name: doc.name,
    price: doc.price,
    image: doc.image,
    isAvailable: doc.isAvailable,
    displayOrder: doc.displayOrder,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function invalidateAddonsCache(): void {
  memoryAll = null;
  memoryAvailable = null;

  try {
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (cache) {
      void cache.delete(CACHE_URL);
    }
  } catch {
    // Cache API may be unavailable in some runtimes
  }
}

export async function getCachedAddons(
  db: Db,
  options: { availableOnly: boolean },
): Promise<AddonPublic[]> {
  const now = Date.now();
  const bucket = options.availableOnly ? memoryAvailable : memoryAll;
  if (bucket && bucket.expiresAt > now) {
    return bucket.items;
  }

  await ensureAddonIndexes(db);
  const collection = db.collection<AddonDoc>(COLLECTIONS.ADDONS);
  const filter = options.availableOnly ? { isAvailable: true } : {};

  const docs = await collection
    .find(filter, { projection: { _id: 0, imagePublicId: 0 } })
    .sort({ displayOrder: 1, name: 1 })
    .toArray();

  const items = docs.map((doc) => toPublic(doc as AddonDoc));
  const next: CacheBucket = { items, expiresAt: now + MEMORY_TTL_MS };

  if (options.availableOnly) {
    memoryAvailable = next;
  } else {
    memoryAll = next;
  }

  return items;
}

export async function matchEdgeAddonsCache(): Promise<Response | undefined> {
  try {
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (!cache) return undefined;
    return (await cache.match(CACHE_URL)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function putEdgeAddonsCache(response: Response, ctx?: { waitUntil?: (p: Promise<unknown>) => void }): void {
  try {
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (!cache) return;
    const clone = response.clone();
    const task = cache.put(CACHE_URL, clone);
    if (ctx?.waitUntil) {
      ctx.waitUntil(task);
    } else {
      void task;
    }
  } catch {
    // ignore
  }
}
