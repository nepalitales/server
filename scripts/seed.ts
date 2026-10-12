/**
 * Database seed script.
 *
 * Seeds the initial admin account, default categories, all products,
 * default weekly off, and creates required MongoDB indexes.
 *
 * Run with: npx tsx scripts/seed.ts
 */

import { MongoClient } from "mongodb";

// ─── Configuration ───────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";

// Attempt to load .env or .dev.vars if environment variables are not set
if (!process.env.MONGODB_URI) {
  for (const envFile of [".env", ".dev.vars"]) {
    try {
      const filePath = path.resolve(process.cwd(), envFile);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key] && val) {
              process.env[key] = val;
            }
          }
        }
      }
    } catch {}
  }
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("[ERROR] MONGODB_URI environment variable is required.");
  process.exit(1);
}

const DB_NAME = process.env.MONGODB_DB_NAME || "nepali-tales";

// ─── PBKDF2 Password Hashing (Web Crypto API) ───────────────────

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LENGTH * 8,
  );

  const hashHex = bufToHex(new Uint8Array(derivedBits));
  const saltHex = bufToHex(salt);

  return `${saltHex}:${hashHex}`;
}

function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.getRandomValues(new Uint8Array(6));
  const randomStr = bufToHex(random).slice(0, 8);
  return `${prefix}_${timestamp}${randomStr}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Seed Data ───────────────────────────────────────────────────

async function seed() {
  console.log("Starting database seed...\n");

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log("[OK] Connected to MongoDB Atlas\n");

    const db = client.db(DB_NAME);

    // ── 1. Create indexes ─────────────────────────────────────

    console.log("Creating indexes...");

    // Admin indexes
    await db.collection("admins").createIndex({ email: 1 }, { unique: true });
    await db.collection("admins").createIndex({ phone: 1 }, { unique: true });
    await db.collection("admins").createIndex({ id: 1 }, { unique: true });

    // Session indexes - TTL index auto-purges expired sessions
    await db.collection("sessions").createIndex({ token: 1 }, { unique: true });
    await db.collection("sessions").createIndex({ adminId: 1 });
    await db.collection("sessions").createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );

    // Product indexes
    await db.collection("products").createIndex({ id: 1 }, { unique: true });
    await db.collection("products").createIndex({ categoryId: 1 });
    await db.collection("products").createIndex({ categorySlug: 1, name: 1 });
    await db.collection("products").createIndex({ isAvailable: 1 });

    // Category indexes
    await db.collection("categories").createIndex({ id: 1 }, { unique: true });
    await db.collection("categories").createIndex({ slug: 1 }, { unique: true });

    // Order window indexes
    await db.collection("order_windows").createIndex({ day: 1 }, { unique: true });

    // Holiday indexes
    await db.collection("holidays").createIndex({ id: 1 }, { unique: true });
    await db.collection("holidays").createIndex({ date: 1 }, { unique: true });

    // FAQ indexes
    await db.collection("faqs").createIndex({ id: 1 }, { unique: true });
    await db.collection("faqs").createIndex({ isActive: 1, displayOrder: 1 });
    await db.collection("faqs").createIndex({ category: 1 });

    // Orders indexes
    await db.collection("orders").createIndex({ id: 1 }, { unique: true });
    await db.collection("orders").createIndex({ orderNumber: 1 }, { unique: true });
    await db.collection("orders").createIndex({ createdAt: -1 });
    await db.collection("orders").createIndex({ status: 1 });
    await db.collection("orders").createIndex({ "payment.razorpayOrderId": 1 });
    await db.collection("orders").createIndex({ "customer.phone": 1 });
    await db.collection("orders").createIndex({ dispatchDate: 1, "dispatchSlot.id": 1 });

    // Order Events indexes (for live summary polling & change log)
    await db.collection("order_events").createIndex({ timestamp: 1 });
    await db.collection("order_events").createIndex({ orderId: 1 });

    // Dispatch Windows & Slot Buckets indexes
    await db.collection("dispatch_windows").createIndex({ day: 1 }, { unique: true });
    await db.collection("dispatch_slot_buckets").createIndex({ date: 1 });
    await db.collection("dispatch_slot_buckets").createIndex({ date: 1, slotId: 1 });

    // Add-on indexes (images stored in Cloudinary; metadata in MongoDB)
    await db.collection("addons").createIndex({ id: 1 }, { unique: true });
    await db.collection("addons").createIndex({ isAvailable: 1, displayOrder: 1, name: 1 });

    await db.collection("order_settings").createIndex({ docId: 1 }, { unique: true });
    await db.collection("orders").createIndex({ orderType: 1, status: 1 });
    await db.collection("orders").createIndex({ userId: 1, createdAt: -1 });

    // Client users & sessions
    await db.collection("client_users").createIndex({ id: 1 }, { unique: true });
    await db.collection("client_users").createIndex({ email: 1 }, { unique: true, sparse: true });
    await db.collection("client_users").createIndex({ phone: 1 }, { sparse: true });
    await db.collection("client_sessions").createIndex({ token: 1 }, { unique: true });
    await db.collection("client_sessions").createIndex({ userId: 1 });
    await db.collection("client_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    // Client OTPs & Addresses
    await db.collection("client_otps").createIndex({ identifier: 1 });
    await db.collection("client_otps").createIndex({ lastIp: 1, createdAt: 1 });
    await db.collection("client_otps").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection("client_addresses").createIndex({ id: 1 }, { unique: true });
    await db.collection("client_addresses").createIndex({ userId: 1 });

    console.log("  [OK] All indexes created\n");

    // ── 2. Seed admin ─────────────────────────────────────────

    console.log("Seeding admin accounts...");

    const initialAdmins = [
      {
        name: "Ankit Bhavarthe",
        email: "ankitbhavarthe123@gmail.com",
        phone: "9309348875",
        password: "2003@A",
      },
      {
        name: "Admin 1",
        email: "nepalitalesadmin1@gmail.com",
        phone: "7585080407",
        password: "JuicyMomo@2026",
      },
      {
        name: "Admin 2",
        email: "nepalitalesadmin2@gmail.com",
        phone: "7602277431",
        password: "JuicyMomo@2026",
      },
    ];

    for (const adm of initialAdmins) {
      const existing = await db.collection("admins").findOne({ email: adm.email });
      if (existing) {
        console.log(`  [SKIP] Admin ${adm.email} already exists, skipping`);
      } else {
        const passwordHash = await hashPassword(adm.password);
        await db.collection("admins").insertOne({
          id: generateId("admin"),
          name: adm.name,
          email: adm.email,
          phone: adm.phone,
          passwordHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`  [OK] Admin created: ${adm.email}`);
      }
    }
    console.log("");

    // ── 3. Seed categories ────────────────────────────────────

    console.log("Seeding categories...");

    // Remove obsolete "Veg Menu" and "Non Veg Menu" categories if present
    await db.collection("categories").deleteMany({
      slug: { $in: ["veg-menu", "non-veg-menu"] },
    });

    const categoryDefs = [
      { name: "Momo", order: 1 },
      { name: "Shaphaley", order: 2 },
    ];

    const categoryMap = new Map<string, string>(); // slug → id

    for (const cat of categoryDefs) {
      const slug = slugify(cat.name);
      const existing = await db.collection("categories").findOne({ slug });

      if (existing) {
        categoryMap.set(slug, existing.id);
        console.log(`  [SKIP] Category "${cat.name}" exists`);
      } else {
        const id = generateId("cat");
        await db.collection("categories").insertOne({
          id,
          name: cat.name,
          slug,
          displayOrder: cat.order,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        categoryMap.set(slug, id);
        console.log(`  [OK] Category created: ${cat.name}`);
      }
    }
    console.log();

    // ── 4. Seed products ──────────────────────────────────────

    console.log("Seeding products...");

    const momoCategoryId = categoryMap.get("momo")!;
    const shaphaleyCategoryId = categoryMap.get("shaphaley")!;

    const products = [
      // ── Momo (All 6 pcs) ──────────────────────────────────
      {
        name: "Veg Steamed Momo",
        description:
          "Bite-sized dumplings filled with fresh and finely chopped cabbage, onion, soya chunks and wrapped in a thin, soft flour dough. Served with peanut chutney, red spicy chutney and chilli oil.",
        price: 189,
        categoryId: momoCategoryId,
        categorySlug: "momo",
        type: "veg" as const,
        quantity: "6 pcs",
      },
      {
        name: "Veg Kothey",
        description:
          "Bite-sized dumplings filled with fresh and finely chopped cabbage, onion, soya chunks and wrapped in a thin, soft flour dough. Steamed and only bottom part of momo is pan fried. Served with peanut chutney, red spicy chutney, and chilli oil.",
        price: 219,
        categoryId: momoCategoryId,
        categorySlug: "momo",
        type: "veg" as const,
        quantity: "6 pcs",
      },
      {
        name: "Veg Fried",
        description:
          "Bite-sized dumplings filled with fresh and finely chopped cabbage, onion, soya chunks and wrapped in a thin, soft flour dough. Steamed and deep fried until brown and crunchy. Served with peanut chutney, red spicy chutney and chilli oil.",
        price: 229,
        categoryId: momoCategoryId,
        categorySlug: "momo",
        type: "veg" as const,
        quantity: "6 pcs",
      },
      {
        name: "Veg Jhol",
        description:
          "Steamed momo served with a soup which is rich, creamy, and nutty flavor from roasted sesame seeds and peanuts or soybeans. Momo and the jhol is packed separately with chilli oil.",
        price: 239,
        categoryId: momoCategoryId,
        categorySlug: "momo",
        type: "veg" as const,
        quantity: "6 pcs",
      },
      {
        name: "Chicken Steamed Momo",
        description:
          "Soft dumplings filled with juicy minced chicken mixed with aromatics like onion, ginger and steamed. Served with peanut chutney, spicy red chutney and chilli oil.",
        price: 210,
        categoryId: momoCategoryId,
        categorySlug: "momo",
        type: "non-veg" as const,
        quantity: "6 pcs",
      },
      {
        name: "Chicken Kothey Momo",
        description:
          "Soft dumplings filled with juicy minced chicken mixed with aromatics like onion, ginger and steamed, and only bottom part of momo is pan fried. Served with peanut chutney, red spicy chutney and chilli oil.",
        price: 229,
        categoryId: momoCategoryId,
        categorySlug: "momo",
        type: "non-veg" as const,
        quantity: "6 pcs",
      },
      {
        name: "Chicken Jhol Momo",
        description:
          "Steamed momo served with the soup which is rich and creamy, and nutty flavour from roasted sesame seeds and peanut, soyabean. Momo and jhol is packed separately and chilli oil.",
        price: 249,
        categoryId: momoCategoryId,
        categorySlug: "momo",
        type: "non-veg" as const,
        quantity: "6 pcs",
      },

      // ── Shaphaley (All 2 pcs) ─────────────────────────────
      {
        name: "Veg Shaphaley",
        description:
          "Crispy, golden-brown fried dough pocket stuffed with a savory, spiced vegetable filling. Crunchy on outside and soft inside. Served with peanut chutney, red spicy chutney and chilli oil.",
        price: 210,
        categoryId: shaphaleyCategoryId,
        categorySlug: "shaphaley",
        type: "veg" as const,
        quantity: "2 pcs",
      },
      {
        name: "Chicken Shaphaley",
        description:
          "Made of crispy fried bread stuffed with seasoned minced chicken, onions, and spices. Served with peanut chutney, red spicy chutney and chilli oil.",
        price: 239,
        categoryId: shaphaleyCategoryId,
        categorySlug: "shaphaley",
        type: "non-veg" as const,
        quantity: "2 pcs",
      },
    ];

    for (const product of products) {
      const existing = await db
        .collection("products")
        .findOne({ name: product.name });

      const now = new Date();
      if (existing) {
        // Update product category, type, and quantity
        await db.collection("products").updateOne(
          { id: existing.id },
          {
            $set: {
              categoryId: product.categoryId,
              categorySlug: product.categorySlug,
              type: product.type,
              quantity: product.quantity,
              price: product.price,
              description: product.description,
              updatedAt: now,
            },
          },
        );
        console.log(`  [UPDATE] Product "${product.name}" updated (Category: ${product.categorySlug}, Type: ${product.type}, Qty: ${product.quantity})`);
      } else {
        await db.collection("products").insertOne({
          id: generateId("prod"),
          name: product.name,
          description: product.description,
          price: product.price,
          image: "",
          categoryId: product.categoryId,
          categorySlug: product.categorySlug,
          type: product.type,
          quantity: product.quantity,
          isAvailable: true,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`  [OK] Product created: ${product.name} (Category: ${product.categorySlug}, Type: ${product.type}, Qty: ${product.quantity})`);
      }
    }
    console.log();

    // ── 5. Seed weekly off ────────────────────────────────────

    console.log("Seeding weekly off (default: Monday)...");

    const existingOff = await db.collection("weekly_off").findOne({});
    if (existingOff) {
      console.log("  [SKIP] Weekly off config exists\n");
    } else {
      await db.collection("weekly_off").insertOne({
        days: ["monday"],
        updatedAt: new Date(),
      });
      console.log("  [OK] Weekly off set to Monday\n");
    }

    // ── 6. Seed FAQs ──────────────────────────────────────────

    console.log("Seeding FAQs...");

    const initialFaqs = [
      {
        question: "Where are you located?",
        answer:
          "We operate from Kasarvadavali, Thane as a cloud kitchen.\nIn simple words: no fancy dining tables, no waiting for a waiter to find your table. Just good food delivered to your doorstep.",
        category: "General",
        displayOrder: 1,
        isActive: true,
      },
      {
        question: "Do you have dine-in facilities?",
        answer:
          "Nope!\nWe're a delivery-only cloud kitchen for now. Think of us as your favourite Nepali food hidden in a secret kitchen somewhere in Thane.",
        category: "General",
        displayOrder: 2,
        isActive: true,
      },
      {
        question: "What's your most popular dish?",
        answer:
          "This question is like asking a parent to pick their favourite child.\nBut if we must:\nJhol Momo\nKothey Momo\nShaphaley\nHonestly? All of them.",
        category: "Menu",
        displayOrder: 3,
        isActive: true,
      },
      {
        question: "Are the momo spicy?",
        answer:
          "The momo? No.\nThe chutney? Absolutely yes.\nThe chutney woke up this morning and chose violence.",
        category: "Menu",
        displayOrder: 4,
        isActive: true,
      },
      {
        question: "Does the food get soggy or cold during delivery?",
        answer:
          "Soggy? Nope.\nCold? Maybe, depending on how far you are and how many traffic signals your delivery rider meets on the way.\nIf it arrives a little chilly, simply steam or microwave it for 4 to 5 minutes.\nYour momo will be back to their happy selves.",
        category: "Delivery",
        displayOrder: 5,
        isActive: true,
      },
      {
        question: "Are the momo freshly prepared?",
        answer:
          "Yes!\nWe don't have an army of momo sitting around waiting for orders.\nEvery order is prepared with fresh ingredients and cooked fresh before delivery.\nYour momo's journey starts only after you click \"Order.\"",
        category: "Food Quality",
        displayOrder: 6,
        isActive: true,
      },
      {
        question: "Why does Nepali Tales operate on pre-orders?",
        answer:
          "Because we're a small kitchen with big standards.\nWe'd rather serve 100 happy customers than 500 disappointed ones.\nPre-orders allow us to:\n- Source ingredients thoughtfully\n- Prepare food fresh for every customer\n- Reduce food waste\n- Stay true to authentic Nepali flavours\nIn short, we're not trying to be the fastest kitchen.\nWe're trying to be the kitchen you remember.",
        category: "Ordering",
        displayOrder: 7,
        isActive: true,
      },
      {
        question: "Why does my order take a little longer?",
        answer:
          "Because good momo takes time.\nIf instant noodles and handmade momo ran a race, instant noodles would win every time.\nWe're okay with that.",
        category: "Ordering",
        displayOrder: 8,
        isActive: true,
      },
      {
        question: "Who runs Nepali Tales?",
        answer:
          "Just two dreamers, Ashika & Dipesh trying to bring a little bit of Authentic Nepali MOMO to Thane & Mumbai, one momo at a time.\nAnd yes, we probably get more excited about your order than you do.",
        category: "About Us",
        displayOrder: 9,
        isActive: true,
      },
    ];

    for (const faq of initialFaqs) {
      const existing = await db.collection("faqs").findOne({ question: faq.question });
      if (existing) {
        console.log(`  [SKIP] FAQ exists: "${faq.question}"`);
      } else {
        const now = new Date();
        await db.collection("faqs").insertOne({
          id: generateId("faq"),
          question: faq.question,
          answer: faq.answer,
          category: faq.category,
          displayOrder: faq.displayOrder,
          isActive: faq.isActive,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`  [OK] FAQ created: "${faq.question}"`);
      }
    }
    console.log();

    // ── Done ──────────────────────────────────────────────────

    console.log("Seed complete!");
  } catch (error) {
    console.error("[ERROR] Seed failed:", error);
    process.exit(1);
  } finally {
    await client.close();
    console.log("\nDisconnected from MongoDB");
  }
}

seed();
