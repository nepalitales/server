import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { COLLECTIONS } from "../../lib/db";
import { generateId } from "../../lib/crypto";
import { createAddressSchema, updateAddressSchema } from "../../schemas";
import { formatZodErrors } from "../../utils";
import { clientAuthMiddleware } from "../../middleware/client-auth";
import type { ClientAddressDoc, BorzoAddressFormat } from "../../types";

const clientAddressRoutes = new Hono<AppBindings>();

// All address routes require authenticated customer
clientAddressRoutes.use("*", clientAuthMiddleware);

/**
 * Formats a saved client address into Borzo API Delivery Point specification.
 *
 * Borzo expects:
 * - `address`: Full string geocoded by Borzo's address parser.
 * - `note`: Floor, apartment/flat number, landmarks for the courier.
 * - `latitude` / `longitude`: Optional coordinates for pin-point courier accuracy.
 */
export function formatBorzoAddress(
  addr: Pick<
    ClientAddressDoc,
    | "street"
    | "building"
    | "floor"
    | "apartment"
    | "landmark"
    | "city"
    | "pincode"
    | "latitude"
    | "longitude"
  >,
): BorzoAddressFormat {
  const addressParts: string[] = [];
  if (addr.building) addressParts.push(addr.building.trim());
  if (addr.street) addressParts.push(addr.street.trim());
  if (addr.city) addressParts.push(addr.city.trim());
  if (addr.pincode) addressParts.push(addr.pincode.trim());

  const address = addressParts.join(", ");

  const noteParts: string[] = [];
  if (addr.apartment) noteParts.push(`Flat/Apt: ${addr.apartment.trim()}`);
  if (addr.floor) noteParts.push(`Floor: ${addr.floor.trim()}`);
  if (addr.landmark) noteParts.push(`Landmark: ${addr.landmark.trim()}`);

  const note = noteParts.join(", ");

  return {
    address,
    note,
    latitude: addr.latitude,
    longitude: addr.longitude,
  };
}

/** Helper to attach borzoFormat to an address doc */
function toClientAddressResponse(doc: ClientAddressDoc) {
  const { _id, ...rest } = doc;
  return {
    ...rest,
    borzoFormat: formatBorzoAddress(doc),
  };
}

// ─── 1. List Customer Addresses ───────────────────────────────────

/**
 * GET /api/client/addresses
 *
 * Returns all saved delivery addresses for the authenticated customer.
 * Sorted with the default address first, followed by newest.
 */
clientAddressRoutes.get("/", async (c) => {
  try {
    const userId = c.get("userId")!;
    const db = c.get("db");
    const collection = db.collection<ClientAddressDoc>(COLLECTIONS.CLIENT_ADDRESSES);

    const addresses = await collection
      .find({ userId })
      .sort({ isDefault: -1, updatedAt: -1 })
      .toArray();

    return c.json({
      success: true,
      addresses: addresses.map(toClientAddressResponse),
      count: addresses.length,
    });
  } catch (error) {
    console.error("List client addresses error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 2. Add New Address ───────────────────────────────────────────

/**
 * POST /api/client/addresses
 *
 * Saves a new delivery address for the customer.
 * If this is the user's first address or isDefault is true, marks as default.
 * Returns the address along with Borzo-compatible geocoding format.
 *
 * Body: createAddressSchema
 */
clientAddressRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createAddressSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid address data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const userId = c.get("userId")!;
    const db = c.get("db");
    const collection = db.collection<ClientAddressDoc>(COLLECTIONS.CLIENT_ADDRESSES);

    const existingCount = await collection.countDocuments({ userId });
    // First address is automatically default; otherwise respect requested flag
    const shouldBeDefault = existingCount === 0 || parsed.data.isDefault === true;

    if (shouldBeDefault && existingCount > 0) {
      // Unset previous defaults
      await collection.updateMany({ userId }, { $set: { isDefault: false } });
    }

    const newAddress: ClientAddressDoc = {
      id: generateId("addr"),
      userId,
      label: parsed.data.label || "Home",
      street: parsed.data.street,
      building: parsed.data.building,
      floor: parsed.data.floor,
      apartment: parsed.data.apartment,
      landmark: parsed.data.landmark,
      city: parsed.data.city || "Mumbai",
      pincode: parsed.data.pincode,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      isDefault: shouldBeDefault,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await collection.insertOne(newAddress as any);

    return c.json(
      {
        success: true,
        message: "Address saved successfully",
        address: toClientAddressResponse(newAddress),
      },
      201,
    );
  } catch (error) {
    console.error("Create client address error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 3. Get Single Address ────────────────────────────────────────

/**
 * GET /api/client/addresses/:addressId
 *
 * Retrieves a single address by ID for the authenticated customer.
 */
clientAddressRoutes.get("/:addressId", async (c) => {
  try {
    const addressId = c.req.param("addressId");
    const userId = c.get("userId")!;
    const db = c.get("db");
    const collection = db.collection<ClientAddressDoc>(COLLECTIONS.CLIENT_ADDRESSES);

    const address = await collection.findOne({ id: addressId, userId });

    if (!address) {
      return c.json({ success: false, message: "Address not found" }, 404);
    }

    return c.json({
      success: true,
      address: toClientAddressResponse(address),
    });
  } catch (error) {
    console.error("Get client address error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 4. Update Address ────────────────────────────────────────────

/**
 * PATCH /api/client/addresses/:addressId
 *
 * Updates an existing delivery address.
 * Body: updateAddressSchema
 */
clientAddressRoutes.patch("/:addressId", async (c) => {
  try {
    const addressId = c.req.param("addressId");
    const userId = c.get("userId")!;
    const body = await c.req.json();
    const parsed = updateAddressSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          message: "Invalid address data",
          errors: formatZodErrors(parsed.error),
        },
        400,
      );
    }

    const db = c.get("db");
    const collection = db.collection<ClientAddressDoc>(COLLECTIONS.CLIENT_ADDRESSES);

    const existing = await collection.findOne({ id: addressId, userId });
    if (!existing) {
      return c.json({ success: false, message: "Address not found" }, 404);
    }

    // If setting as default, unset other addresses
    if (parsed.data.isDefault === true) {
      await collection.updateMany(
        { userId, id: { $ne: addressId } },
        { $set: { isDefault: false } },
      );
    }

    const updateFields: Partial<ClientAddressDoc> = {
      ...parsed.data,
      updatedAt: new Date(),
    };

    await collection.updateOne({ id: addressId, userId }, { $set: updateFields });

    const updated = await collection.findOne({ id: addressId, userId });

    return c.json({
      success: true,
      message: "Address updated successfully",
      address: updated ? toClientAddressResponse(updated) : null,
    });
  } catch (error) {
    console.error("Update client address error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 5. Set As Default Address ─────────────────────────────────────

/**
 * PUT /api/client/addresses/:addressId/default
 *
 * Sets the specified address as the customer's primary default address.
 */
clientAddressRoutes.put("/:addressId/default", async (c) => {
  try {
    const addressId = c.req.param("addressId");
    const userId = c.get("userId")!;
    const db = c.get("db");
    const collection = db.collection<ClientAddressDoc>(COLLECTIONS.CLIENT_ADDRESSES);

    const existing = await collection.findOne({ id: addressId, userId });
    if (!existing) {
      return c.json({ success: false, message: "Address not found" }, 404);
    }

    // Unset all other defaults
    await collection.updateMany(
      { userId, id: { $ne: addressId } },
      { $set: { isDefault: false } },
    );

    // Set this address as default
    await collection.updateOne(
      { id: addressId, userId },
      { $set: { isDefault: true, updatedAt: new Date() } },
    );

    const updated = await collection.findOne({ id: addressId, userId });

    return c.json({
      success: true,
      message: "Default address updated",
      address: updated ? toClientAddressResponse(updated) : null,
    });
  } catch (error) {
    console.error("Set default client address error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// ─── 6. Delete Address ────────────────────────────────────────────

/**
 * DELETE /api/client/addresses/:addressId
 *
 * Deletes a saved delivery address.
 * If the deleted address was the default, promotes the next address to default.
 */
clientAddressRoutes.delete("/:addressId", async (c) => {
  try {
    const addressId = c.req.param("addressId");
    const userId = c.get("userId")!;
    const db = c.get("db");
    const collection = db.collection<ClientAddressDoc>(COLLECTIONS.CLIENT_ADDRESSES);

    const existing = await collection.findOne({ id: addressId, userId });
    if (!existing) {
      return c.json({ success: false, message: "Address not found" }, 404);
    }

    await collection.deleteOne({ id: addressId, userId });

    // If was default, promote next available address
    if (existing.isDefault) {
      const nextAddress = await collection.findOne(
        { userId },
        { sort: { updatedAt: -1 } },
      );
      if (nextAddress) {
        await collection.updateOne(
          { id: nextAddress.id },
          { $set: { isDefault: true, updatedAt: new Date() } },
        );
      }
    }

    return c.json({
      success: true,
      message: "Address deleted successfully",
    });
  } catch (error) {
    console.error("Delete client address error:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

export { clientAddressRoutes };
