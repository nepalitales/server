import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";

const CONFIG_VERSION_DOC_ID = "global";

/**
 * Bumps the config version in MongoDB.
 * Called by every admin mutation that clients care about:
 * - order windows, weekly off, holidays.
 *
 * The SSE endpoint polls this document and notifies connected
 * clients when the version changes, prompting a re-fetch.
 */
export async function bumpConfigVersion(db: Db): Promise<string> {
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

  return version;
}

/**
 * Returns the current config version string.
 * Returns "0" if no version doc exists yet.
 */
export async function getConfigVersion(db: Db): Promise<string> {
  const collection = db.collection<{
    docId: string;
    version: string;
  }>(COLLECTIONS.CONFIG_VERSION);

  const doc = await collection.findOne({ docId: CONFIG_VERSION_DOC_ID });
  return doc?.version ?? "0";
}
