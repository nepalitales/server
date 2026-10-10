import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import type { OrderSettingsDoc } from "../types";

export const ORDER_SETTINGS_DOC_ID = "global";

export const DEFAULT_ORDER_SETTINGS: Omit<OrderSettingsDoc, "_id" | "updatedAt"> = {
  docId: ORDER_SETTINGS_DOC_ID,
  pickupEnabled: true,
  deliveryEnabled: true,
  deliveryFee: 0,
  pickupInstructions:
    "Collect your order from the kitchen at Metropolis Riveria, Kasarvadavali, Ghodbunder Road, Thane.",
};

export async function getOrderSettings(db: Db): Promise<OrderSettingsDoc> {
  const collection = db.collection<OrderSettingsDoc>(COLLECTIONS.ORDER_SETTINGS);
  const doc = await collection.findOne({ docId: ORDER_SETTINGS_DOC_ID });
  if (doc) return doc;

  const created: OrderSettingsDoc = {
    ...DEFAULT_ORDER_SETTINGS,
    updatedAt: new Date(),
  };
  await collection.updateOne(
    { docId: ORDER_SETTINGS_DOC_ID },
    { $setOnInsert: created },
    { upsert: true },
  );
  return created;
}

export function publicOrderSettings(doc: OrderSettingsDoc) {
  return {
    pickupEnabled: doc.pickupEnabled,
    deliveryEnabled: doc.deliveryEnabled,
    deliveryFee: doc.deliveryFee,
    pickupInstructions: doc.pickupInstructions,
  };
}
