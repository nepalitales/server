import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import type {
  OrderWindowDoc,
  WeeklyOffDoc,
  HolidayDoc,
  DayOfWeek,
  TimeWindow,
  OrderDoc,
} from "../types";

export interface OrderWindowCheckResult {
  isOpen: boolean;
  message: string;
  currentWindow: TimeWindow | null;
  /** Exact Date when customer cancellation window ends (end of the current order window) */
  canCancelUntil: Date | null;
  todayDateStr: string; // "YYYY-MM-DD" in IST
  todayDay: DayOfWeek;
  activeWindows: TimeWindow[];
  isSlotCapacityFull?: boolean;
  currentSlotOrdersCount?: number;
  maxSlotOrders?: number;
}

const DAYS_MAP: DayOfWeek[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * Gets the current date, time, and day of the week in Indian Standard Time (Asia/Kolkata).
 */
export function getIstDateTime(): {
  dateStr: string; // "YYYY-MM-DD"
  timeStr: string; // "HH:mm"
  dayName: DayOfWeek;
  now: Date;
} {
  const now = new Date();

  // Extract parts in IST
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  }).formatToParts(now);

  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || "";

  const year = getPart("year");
  const month = getPart("month");
  const day = getPart("day");
  const hour = getPart("hour");
  const minute = getPart("minute");
  const weekday = getPart("weekday").toLowerCase() as DayOfWeek;

  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${hour}:${minute}`,
    dayName: weekday,
    now,
  };
}

/**
 * Creates a Date object for a specific "HH:mm" time on today's date in IST.
 */
export function getIstDateForTime(hhMm: string, dateStr: string): Date {
  // Construct ISO string for IST (+05:30)
  const iso = `${dateStr}T${hhMm}:00+05:30`;
  return new Date(iso);
}

/**
 * Checks whether ordering is currently open based on:
 * 1. Holidays (today's date)
 * 2. Weekly Off schedule
 * 3. Daily Order Windows (e.g. 6:00 AM - 8:00 AM)
 *
 * In development mode, `allowDevBypass` can permit testing even when outside hours.
 */
export async function checkOrderWindow(
  db: Db,
  allowDevBypass = false,
): Promise<OrderWindowCheckResult> {
  const { dateStr, timeStr, dayName, now } = getIstDateTime();

  // In Nepali Tales' advance pre-order model, customers can place orders on any day
  // (including kitchen weekly off days) within the day's configured ordering window,
  // with delivery scheduled for the next open cooking/dispatch operating day.

  // Check Order Window for today
  const orderWindows = db.collection<OrderWindowDoc>(COLLECTIONS.ORDER_WINDOWS);
  const todayWindowDoc = await orderWindows.findOne({ day: dayName });

  if (!todayWindowDoc || !todayWindowDoc.enabled || !todayWindowDoc.windows.length) {
    if (allowDevBypass) {
      console.warn(`[OrderWindow Dev Bypass]: No windows enabled for ${dayName}, but dev bypass is active.`);
    } else {
      return {
        isOpen: false,
        message: `Ordering is closed for today.`,
        currentWindow: null,
        canCancelUntil: null,
        todayDateStr: dateStr,
        todayDay: dayName,
        activeWindows: [],
      };
    }
  }

  const windows = todayWindowDoc?.windows ?? [];

  // Find if current time falls within any window
  let matchedWindow: TimeWindow | null = null;

  for (const win of windows) {
    if (timeStr >= win.start && timeStr <= win.end) {
      matchedWindow = win;
      break;
    }
  }

  if (matchedWindow) {
    const canCancelUntil = getIstDateForTime(matchedWindow.end, dateStr);
    const windowStart = getIstDateForTime(matchedWindow.start, dateStr);
    const maxOrders = matchedWindow.maxOrders;
    let currentSlotOrdersCount: number | undefined = undefined;

    // Only enforce capacity if an explicit positive maxOrders cap was set by the admin
    if (maxOrders !== undefined && maxOrders !== null && maxOrders > 0) {
      // Check how many orders have been placed in this specific order window today
      const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);
      currentSlotOrdersCount = await ordersCol.countDocuments({
        createdAt: { $gte: windowStart, $lte: canCancelUntil },
        status: { $nin: ["cancelled_by_customer", "cancelled_by_admin"] },
      });

      if (currentSlotOrdersCount >= maxOrders) {
        if (allowDevBypass) {
          console.warn(`[OrderWindow Dev Bypass]: Slot ${matchedWindow.start}-${matchedWindow.end} reached capacity (${currentSlotOrdersCount}/${maxOrders}), but dev bypass is active.`);
        } else {
          return {
            isOpen: false,
            isSlotCapacityFull: true,
            message: `Current order window (${matchedWindow.start} - ${matchedWindow.end}) has reached its capacity limit (${maxOrders} orders). Kitchen is currently full for this window.`,
            currentWindow: matchedWindow,
            canCancelUntil: null,
            todayDateStr: dateStr,
            todayDay: dayName,
            activeWindows: windows,
            currentSlotOrdersCount,
            maxSlotOrders: maxOrders,
          };
        }
      }
    }

    return {
      isOpen: true,
      message: `Ordering is open until ${matchedWindow.end}`,
      currentWindow: matchedWindow,
      canCancelUntil,
      todayDateStr: dateStr,
      todayDay: dayName,
      activeWindows: windows,
      currentSlotOrdersCount,
      maxSlotOrders: maxOrders,
    };
  }

  // Not in any active window
  if (allowDevBypass) {
    // In dev bypass, synthesize a window valid for next 2 hours
    const defaultEnd = getIstDateForTime("23:59", dateStr);
    return {
      isOpen: true,
      message: `[Dev Mode] Ordering window bypassed for testing`,
      currentWindow: { start: "00:00", end: "23:59" },
      canCancelUntil: defaultEnd,
      todayDateStr: dateStr,
      todayDay: dayName,
      activeWindows: windows,
    };
  }

  const windowSummary = windows.map((w) => `${w.start} - ${w.end}`).join(", ");
  return {
    isOpen: false,
    message: windows.length
      ? `Ordering is currently closed. Today's order window(s): ${windowSummary}`
      : `Ordering is closed for today.`,
    currentWindow: null,
    canCancelUntil: null,
    todayDateStr: dateStr,
    todayDay: dayName,
    activeWindows: windows,
  };
}
