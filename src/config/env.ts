import { z } from "zod";

/**
 * Environment variables schema with strict validation.
 * Validated once at startup - fail fast if misconfigured.
 */
export const envSchema = z.object({
  MONGODB_URI: z
    .string()
    .min(1, "MONGODB_URI is required")
    .startsWith("mongodb", "MONGODB_URI must be a valid MongoDB connection string"),

  MONGODB_DB_NAME: z
    .string()
    .min(1, "MONGODB_DB_NAME is required")
    .default("nepali-tales"),

  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),

  // Sentry Observability & Error Alerting
  SENTRY_DSN: z.string().url("SENTRY_DSN must be a valid Sentry URL").optional(),

  // Upstash Redis & Rate Limiting
  UPSTASH_REDIS_REST_URL: z.string().url("UPSTASH_REDIS_REST_URL must be a valid URL").optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

  // Razorpay Payment Gateway
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Resend Email Integration
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().min(1).optional(),
  ADMIN_NOTIFICATION_EMAIL: z.string().email().optional(),

  // Cloud Kitchen Details (for Borzo pickup point 0)
  KITCHEN_ADDRESS: z
    .string()
    .default(
      "Metropolis Rivera, Shop No 10, Kasarvadavali, Opp to Laxmi Narayan Mandir, 400615",
    ),
  KITCHEN_PHONE: z.string().default("917678097659"),

  NODE_ENV: z
    .enum(["development", "production", "staging"])
    .default("production"),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === "production") {
    if (!data.RESEND_API_KEY || data.RESEND_API_KEY.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message: "RESEND_API_KEY is required in production",
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates and returns typed environment variables.
 * Throws descriptive errors for missing/invalid config.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  • ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${formatted}`);
  }
  return result.data;
}
