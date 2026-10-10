import {
  withSentry,
  captureException as sentryCaptureException,
  captureMessage as sentryCaptureMessage,
  withScope,
} from "@sentry/cloudflare";
import type { Env } from "../config/env";

export { withSentry };

/**
 * Captures an exception and reports it to Sentry with extra tags/context.
 * Falls back to console.error safely if Sentry is not configured.
 */
export function captureException(
  error: unknown,
  context?: {
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    user?: { id?: string; phone?: string; username?: string };
  },
): void {
  console.error("Exception captured:", error);

  try {
    withScope((scope) => {
      if (context?.tags) {
        for (const [key, val] of Object.entries(context.tags)) {
          scope.setTag(key, val);
        }
      }
      if (context?.extra) {
        for (const [key, val] of Object.entries(context.extra)) {
          scope.setExtra(key, val);
        }
      }
      if (context?.user) {
        scope.setUser(context.user);
      }
      sentryCaptureException(error);
    });
  } catch {
    // Sentry failure must never crash the application
  }
}

/**
 * Captures a business message or warning alert to Sentry.
 */
export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "info",
  context?: {
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
  },
): void {
  console.log(`[${level.toUpperCase()}] ${message}`);

  try {
    withScope((scope) => {
      scope.setLevel(level);
      if (context?.tags) {
        for (const [key, val] of Object.entries(context.tags)) {
          scope.setTag(key, val);
        }
      }
      if (context?.extra) {
        for (const [key, val] of Object.entries(context.extra)) {
          scope.setExtra(key, val);
        }
      }
      sentryCaptureMessage(message);
    });
  } catch {
    // Silently ignore Sentry transport errors
  }
}
