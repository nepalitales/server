/**
 * Standalone seed script for FAQs.
 *
 * Seeds the initial client FAQs into the `faqs` collection in MongoDB,
 * with indexes for fast querying and ordering.
 *
 * Run with: npx tsx scripts/seed-faqs.ts
 */

import { MongoClient } from "mongodb";
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

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.getRandomValues(new Uint8Array(6));
  const randomStr = bufToHex(random).slice(0, 8);
  return `${prefix}_${timestamp}${randomStr}`;
}

export const INITIAL_FAQS = [
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
    question: "Are the momos spicy?",
    answer:
      "The momos? No.\nThe chutney? Absolutely yes.\nThe chutney woke up this morning and chose violence.",
    category: "Menu",
    displayOrder: 4,
    isActive: true,
  },
  {
    question: "Does the food get soggy or cold during delivery?",
    answer:
      "Soggy? Nope.\nCold? Maybe, depending on how far you are and how many traffic signals your delivery rider meets on the way.\nIf it arrives a little chilly, simply steam or microwave it for 4 to 5 minutes.\nYour momos will be back to their happy selves.",
    category: "Delivery",
    displayOrder: 5,
    isActive: true,
  },
  {
    question: "Are the momos freshly prepared?",
    answer:
      "Yes!\nWe don't have an army of momos sitting around waiting for orders.\nEvery order is prepared with fresh ingredients and cooked fresh before delivery.\nYour momo's journey starts only after you click \"Order.\"",
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
      "Because good momo takes time.\nIf instant noodles and handmade momos ran a race, instant noodles would win every time.\nWe're okay with that.",
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

async function seedFaqs() {
  console.log("Connecting to MongoDB Atlas...");
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log("[OK] Connected successfully\n");

    const db = client.db(DB_NAME);
    const collection = db.collection("faqs");

    console.log("Creating FAQ indexes...");
    await collection.createIndex({ id: 1 }, { unique: true });
    await collection.createIndex({ isActive: 1, displayOrder: 1 });
    await collection.createIndex({ category: 1 });
    console.log("  [OK] Indexes created\n");

    console.log(`Seeding ${INITIAL_FAQS.length} FAQs...`);
    let createdCount = 0;
    let updatedCount = 0;

    for (const faq of INITIAL_FAQS) {
      const existing = await collection.findOne({ question: faq.question });

      if (existing) {
        // Update content to match latest seed if desired
        await collection.updateOne(
          { id: existing.id },
          {
            $set: {
              answer: faq.answer,
              category: faq.category,
              displayOrder: faq.displayOrder,
              isActive: faq.isActive,
              updatedAt: new Date(),
            },
          },
        );
        updatedCount++;
        console.log(`  [UPDATED] Q: "${faq.question}" (order: ${faq.displayOrder})`);
      } else {
        const now = new Date();
        await collection.insertOne({
          id: generateId("faq"),
          question: faq.question,
          answer: faq.answer,
          category: faq.category,
          displayOrder: faq.displayOrder,
          isActive: faq.isActive,
          createdAt: now,
          updatedAt: now,
        });
        createdCount++;
        console.log(`  [CREATED] Q: "${faq.question}" (order: ${faq.displayOrder})`);
      }
    }

    console.log(`\nSeed FAQs complete! (${createdCount} created, ${updatedCount} updated)`);
  } catch (error) {
    console.error("[ERROR] Failed to seed FAQs:", error);
    process.exit(1);
  } finally {
    await client.close();
    console.log("Disconnected from MongoDB");
  }
}

seedFaqs();
