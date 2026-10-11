import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";

const CONFIG_VERSION_DOC_ID = "global";

let memoryCachedVersion: { version: string; expiresAt: number } | null = null;

export function invalidateConfigVersionCache() {
  memoryCachedVersion = null;
}

export function getCachedConfigVersion(): string | null {
  if (memoryCachedVersion && memoryCachedVersion.expiresAt > Date.now()) {
    return memoryCachedVersion.version;
  }
  return null;
}

export function setCachedConfigVersion(version: string) {
  memoryCachedVersion = {
    version,
    expiresAt: Date.now() + 15_000, // 15s isolate TTL
  };
}

/**
 * Bumps the config version in MongoDB.
 * Called by every admin mutation that clients care about:
 * - order windows, weekly off, holidays.
 */
export async function bumpConfigVersion(db: Db): Promise<string> {
  invalidateConfigVersionCache();

  const collection = db.collection<{
    _id?: unknown;
    docId: string;
    version: string;
    updatedAt: Date;
  }>(COLLECTIONS.CONFIG_VERSION);

  const version = Date.now().toString();

  await collection.updateOne(
    { docId: CONFIG_VERSION_DOC_ID },
    {
      $set: {
        docId: CONFIG_VERSION_DOC_ID,
        version,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  setCachedConfigVersion(version);
  return version;
}

/**
 * Returns the current config version string.
 * Returns "0" if no version doc exists yet.
 */
export async function getConfigVersion(db: Db): Promise<string> {
  const cached = getCachedConfigVersion();
  if (cached) return cached;

  const collection = db.collection<{
    docId: string;
    version: string;
  }>(COLLECTIONS.CONFIG_VERSION);

  const doc = await collection.findOne({ docId: CONFIG_VERSION_DOC_ID });
  const version = doc?.version ?? "0";
  setCachedConfigVersion(version);
  return version;
}
