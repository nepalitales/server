import { MongoClient } from "mongodb";
import { hashPassword, generateId } from "../src/lib/crypto";
import { loadEnv } from "./load-env";

loadEnv();

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "nepali-tales";
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;

if (!SEED_ADMIN_PASSWORD || SEED_ADMIN_PASSWORD.length < 12) {
  console.error(
    "\n[SECURITY ERROR] SEED_ADMIN_PASSWORD environment variable is missing or too short.\n" +
      "To seed or update admin accounts, please provide a secure password (minimum 12 characters):\n\n" +
      "  SEED_ADMIN_PASSWORD='your-secure-password' npm run seed:admins\n"
  );
  process.exit(1);
}

const ADMINS_TO_SEED = [
  {
    name: process.env.ADMIN_1_NAME || "Admin 1",
    email: process.env.ADMIN_1_EMAIL || "nepalitalesadmin1@gmail.com",
    phone: process.env.ADMIN_1_PHONE || "7585080407",
  },
  {
    name: process.env.ADMIN_2_NAME || "Admin 2",
    email: process.env.ADMIN_2_EMAIL || "nepalitalesadmin2@gmail.com",
    phone: process.env.ADMIN_2_PHONE || "7602277431",
  },
];

async function seedAdmins() {
  console.log("Connecting to MongoDB Atlas...");
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB_NAME);
  const adminsCol = db.collection("admins");

  try {
    for (const admin of ADMINS_TO_SEED) {
      const normalizedEmail = admin.email.toLowerCase().trim();
      const existing = await adminsCol.findOne({
        $or: [{ email: normalizedEmail }, { phone: admin.phone }],
      });

      const passwordHash = await hashPassword(SEED_ADMIN_PASSWORD);
      const now = new Date();

      if (existing) {
        console.log(`Updating existing admin: ${normalizedEmail}`);
        await adminsCol.updateOne(
          { _id: existing._id },
          {
            $set: {
              name: admin.name,
              email: normalizedEmail,
              phone: admin.phone,
              passwordHash,
              updatedAt: now,
            },
          },
        );
        console.log(`[SUCCESS] Admin updated: ${normalizedEmail}`);
      } else {
        console.log(`Creating new admin: ${normalizedEmail}`);
        const id = generateId("admin");
        await adminsCol.insertOne({
          id,
          name: admin.name,
          email: normalizedEmail,
          phone: admin.phone,
          passwordHash,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`[SUCCESS] Admin created successfully: ${normalizedEmail} (ID: ${id})`);
      }
    }

    const allAdmins = await adminsCol.find({}, { projection: { _id: 0, passwordHash: 0 } }).toArray();
    console.log("\n[INFO] Current Admins in Database:");
    console.table(allAdmins);
  } finally {
    await client.close();
  }
}

seedAdmins().catch((err) => {
  console.error("[FAILED] Failed to seed admins:", err);
  process.exit(1);
});
