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
 * Formats a "HH:mm" time string into 12-hour format with AM/PM (e.g. "02:00 PM").
 */
export function formatTime12(timeStr: string): string {
  if (!timeStr) return "";
  const [hStr, mStr] = timeStr.split(":");
  let h = parseInt(hStr || "0", 10);
  if (isNaN(h)) return timeStr;
  const m = mStr || "00";
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const padH = h < 10 ? `0${h}` : `${h}`;
  return `${padH}:${m} ${ampm}`;
}

/**
 * Gets tomorrow's date and day of the week in Indian Standard Time (Asia/Kolkata).
 */
export function getTomorrowIstDateTime(now = new Date()): {
  dateStr: string; // "YYYY-MM-DD"
  dayName: DayOfWeek;
} {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(tomorrow);

  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const year = getPart("year");
  const month = getPart("month");
  const day = getPart("day");
  const weekday = getPart("weekday").toLowerCase() as DayOfWeek;

  return {
    dateStr: `${year}-${month}-${day}`,
    dayName: weekday,
  };
}

/**
 * Checks whether customer order intake is currently open.
 *
 * In Nepali Tales' next-day pre-order model:
 * - Orders placed today are cooked and delivered tomorrow.
 * - If tomorrow is a Weekly Off or Holiday, the kitchen is closed tomorrow,
 *   so the customer ordering window TODAY is automatically CLOSED.
 *
 * In development mode, `allowDevBypass` can permit testing even when outside hours.
 */
export async function checkOrderWindow(
  db: Db,
  allowDevBypass = false,
): Promise<OrderWindowCheckResult> {
  const { dateStr, timeStr, dayName, now } = getIstDateTime();

  // Next-day pre-order check:
  // If tomorrow is a Weekly Off or Holiday, dispatches are paused tomorrow,
  // meaning NO customer orders can be accepted today.
  const tomorrow = getTomorrowIstDateTime(now);

  // 1. Check if tomorrow is a recurring Weekly Off
  const weeklyOffCol = db.collection<WeeklyOffDoc>(COLLECTIONS.WEEKLY_OFF);
  const weeklyOffDoc = await weeklyOffCol.findOne({});
  const offDays = (weeklyOffDoc?.days ?? []).map((d) => d.toLowerCase() as DayOfWeek);

  if (offDays.includes(tomorrow.dayName)) {
    if (allowDevBypass) {
      console.warn(`[OrderWindow Dev Bypass]: Tomorrow (${tomorrow.dayName}) is Weekly Off, but dev bypass is active.`);
    } else {
      const tomorrowCapitalized = tomorrow.dayName.charAt(0).toUpperCase() + tomorrow.dayName.slice(1);
      return {
        isOpen: false,
        message: `Ordering is closed today (Kitchen off on ${tomorrowCapitalized}). Ordering reopens ${tomorrowCapitalized} from 2:00 PM – 4:00 PM for advance delivery.`,
        currentWindow: null,
        canCancelUntil: null,
        todayDateStr: dateStr,
        todayDay: dayName,
        activeWindows: [],
      };
    }
  }

  // 2. Check if tomorrow is a Holiday
  const holidaysCol = db.collection<HolidayDoc>(COLLECTIONS.HOLIDAYS);
  const tomorrowHoliday = await holidaysCol.findOne({ date: tomorrow.dateStr });

  if (tomorrowHoliday) {
    if (allowDevBypass) {
      console.warn(`[OrderWindow Dev Bypass]: Tomorrow (${tomorrow.dateStr}) is a Holiday (${tomorrowHoliday.reason}), but dev bypass is active.`);
    } else {
      return {
        isOpen: false,
        message: `Ordering is closed today because our kitchen is closed tomorrow for holiday (${tomorrowHoliday.reason || "Scheduled closure"}).`,
        currentWindow: null,
        canCancelUntil: null,
        todayDateStr: dateStr,
        todayDay: dayName,
        activeWindows: [],
      };
    }
  }

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
            message: `Current order window (${formatTime12(matchedWindow.start)} - ${formatTime12(matchedWindow.end)}) has reached its capacity limit (${maxOrders} orders). Kitchen is currently full for this window.`,
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
      message: `Ordering is open until ${formatTime12(matchedWindow.end)}`,
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

  const windowSummary = windows.map((w) => `${formatTime12(w.start)} - ${formatTime12(w.end)}`).join(", ");
  return {
    isOpen: false,
    message: windows.length
      ? `Today's order window opens at ${windowSummary} for advance delivery.`
      : `Ordering is closed for today.`,
    currentWindow: null,
    canCancelUntil: null,
    todayDateStr: dateStr,
    todayDay: dayName,
    activeWindows: windows,
  };
}
