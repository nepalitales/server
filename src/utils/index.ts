import type { ZodError } from "zod";

/**
 * Format Zod validation errors into a flat field to message map using native Zod flatten.
 */
export function formatZodErrors(error: ZodError): Record<string, string> {
  const fields = error.flatten().fieldErrors;
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v?.[0] || "Invalid value"]),
  );
}

/**
 * Convert a string to a URL-friendly slug.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Escape regular expression special characters to prevent ReDoS and regex injection.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

