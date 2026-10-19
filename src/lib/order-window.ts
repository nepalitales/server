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
  windowState: "before" | "open" | "after";
  message: string;
  currentWindow: TimeWindow | null;
  /** Exact Date when customer cancellation window ends (end of the current order window) */
  canCancelUntil: Date | null;
  todayDateStr: string; // "YYYY-MM-DD" in IST
  todayDay: DayOfWeek;
  activeWindows: TimeWindow[];
  nextWindow?: {
    day: DayOfWeek;
    dayLabel: string; // "tomorrow" | "Monday" | "Tuesday", etc.
    start: string;
    end: string;
    timeFormatted: string;
  } | null;
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
/**
 * Formats a "HH:mm" time string cleanly without leading zero (e.g. "2:00 PM").
 */
export function formatTimeDisplay(timeStr: string): string {
  if (!timeStr) return "";
  const [hStr, mStr] = timeStr.split(":");
  let h = parseInt(hStr || "0", 10);
  if (isNaN(h)) return timeStr;
  const m = mStr || "00";
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

/**
 * Formats an order window range cleanly (e.g. "2:00 PM – 4:00 PM").
 */
export function formatWindowSpan(start: string, end: string): string {
  return `${formatTimeDisplay(start)} – ${formatTimeDisplay(end)}`;
}

/**
 * Finds the next scheduled and enabled order window starting from tomorrow up to 7 days ahead,
 * properly respecting weekly off policies and scheduled holidays.
 */
export async function findNextActiveOrderWindow(
  db: Db,
  now: Date,
  offDays: DayOfWeek[]
): Promise<{
  day: DayOfWeek;
  dayLabel: string;
  start: string;
  end: string;
  timeFormatted: string;
} | null> {
  const holidaysCol = db.collection<HolidayDoc>(COLLECTIONS.HOLIDAYS);
  const orderWindowsCol = db.collection<OrderWindowDoc>(COLLECTIONS.ORDER_WINDOWS);

  for (let offset = 1; offset <= 7; offset++) {
    const targetDate = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const targetParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
    }).formatToParts(targetDate);

    const getP = (type: string) => targetParts.find((p) => p.type === type)?.value || "";
    const targetDateStr = `${getP("year")}-${getP("month")}-${getP("day")}`;
    const targetDayName = getP("weekday").toLowerCase() as DayOfWeek;

    // Check dispatch day (the day after targetDate - pre-order next-day model)
    const dispatchDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
    const dispatchParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
    }).formatToParts(dispatchDate);
    const getDP = (type: string) => dispatchParts.find((p) => p.type === type)?.value || "";
    const dispatchDateStr = `${getDP("year")}-${getDP("month")}-${getDP("day")}`;
    const dispatchDayName = getDP("weekday").toLowerCase() as DayOfWeek;

    // If dispatch day is recurring weekly off, kitchen is closed for delivery
    if (offDays.includes(dispatchDayName)) {
      continue;
    }

    // If dispatch day is a scheduled holiday, kitchen is closed
    const dispatchHoliday = await holidaysCol.findOne({ date: dispatchDateStr });
    if (dispatchHoliday) {
      continue;
    }

    // Also check if targetDate itself is a scheduled holiday
    const targetHoliday = await holidaysCol.findOne({ date: targetDateStr });
    if (targetHoliday) {
      continue;
    }

    // Check if targetDay has enabled window in DB
    const targetWindowDoc = await orderWindowsCol.findOne({ day: targetDayName });
    if (
      targetWindowDoc &&
      targetWindowDoc.enabled &&
      targetWindowDoc.windows &&
      targetWindowDoc.windows.length > 0
    ) {
      const win = targetWindowDoc.windows[0];
      if (win) {
        const dayLabel =
          offset === 1
            ? "tomorrow"
            : targetDayName.charAt(0).toUpperCase() + targetDayName.slice(1);
        return {
          day: targetDayName,
          dayLabel,
          start: win.start,
          end: win.end,
          timeFormatted: formatWindowSpan(win.start, win.end),
        };
      }
    }
  }

  return null;
}

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
      const nextWindow = await findNextActiveOrderWindow(db, now, offDays);
      const reopenText = nextWindow
        ? `Opens ${nextWindow.dayLabel} at ${nextWindow.timeFormatted}`
        : "Ordering will reopen during the next scheduled window.";
      return {
        isOpen: false,
        windowState: "after",
        message: `Ordering window closed for today (Kitchen off on ${tomorrowCapitalized}). ${reopenText}`,
        currentWindow: null,
        canCancelUntil: null,
        todayDateStr: dateStr,
        todayDay: dayName,
        activeWindows: [],
        nextWindow,
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
      const nextWindow = await findNextActiveOrderWindow(db, now, offDays);
      const reopenText = nextWindow
        ? `Opens ${nextWindow.dayLabel} at ${nextWindow.timeFormatted}`
        : "Ordering will reopen during the next scheduled window.";
      return {
        isOpen: false,
        windowState: "after",
        message: `Ordering window closed for today (Kitchen closed tomorrow for holiday: ${tomorrowHoliday.reason || "Scheduled closure"}). ${reopenText}`,
        currentWindow: null,
        canCancelUntil: null,
        todayDateStr: dateStr,
        todayDay: dayName,
        activeWindows: [],
        nextWindow,
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
      const nextWindow = await findNextActiveOrderWindow(db, now, offDays);
      const reopenText = nextWindow
        ? `Opens ${nextWindow.dayLabel} at ${nextWindow.timeFormatted}`
        : "Ordering is closed for today.";
      return {
        isOpen: false,
        windowState: "after",
        message: `Ordering window closed for today. ${reopenText}`,
        currentWindow: null,
        canCancelUntil: null,
        todayDateStr: dateStr,
        todayDay: dayName,
        activeWindows: [],
        nextWindow,
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
            windowState: "after",
            isSlotCapacityFull: true,
            message: `Current order window (${formatWindowSpan(matchedWindow.start, matchedWindow.end)}) has reached capacity (${maxOrders} orders). Kitchen is full for this window.`,
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
      windowState: "open",
      message: `Ordering is open until ${formatTimeDisplay(matchedWindow.end)}`,
      currentWindow: matchedWindow,
      canCancelUntil,
      todayDateStr: dateStr,
      todayDay: dayName,
      activeWindows: windows,
      currentSlotOrdersCount,
      maxSlotOrders: maxOrders,
    };
  }

  // Not in any active window: check dev bypass
  if (allowDevBypass) {
    // In dev bypass, synthesize a window valid for next 2 hours
    const defaultEnd = getIstDateForTime("23:59", dateStr);
    return {
      isOpen: true,
      windowState: "open",
      message: `[Dev Mode] Ordering window bypassed for testing`,
      currentWindow: { start: "00:00", end: "23:59" },
      canCancelUntil: defaultEnd,
      todayDateStr: dateStr,
      todayDay: dayName,
      activeWindows: windows,
    };
  }

  // 4. Check if we are BEFORE an upcoming window today
  const upcomingWindowToday = windows.find((win) => timeStr < win.start);
  if (upcomingWindowToday) {
    const timeFormatted = formatWindowSpan(upcomingWindowToday.start, upcomingWindowToday.end);
    return {
      isOpen: false,
      windowState: "before",
      message: `Ordering window opens today at ${timeFormatted}`,
      currentWindow: null,
      canCancelUntil: null,
      todayDateStr: dateStr,
      todayDay: dayName,
      activeWindows: windows,
      nextWindow: {
        day: dayName,
        dayLabel: "today",
        start: upcomingWindowToday.start,
        end: upcomingWindowToday.end,
        timeFormatted,
      },
    };
  }

  // 5. Current time is AFTER all order windows for today have ended
  const nextWindow = await findNextActiveOrderWindow(db, now, offDays);
  const reopenText = nextWindow
    ? `Opens ${nextWindow.dayLabel} at ${nextWindow.timeFormatted}`
    : "Ordering is closed for today.";

  return {
    isOpen: false,
    windowState: "after",
    message: `Ordering window closed for today. ${reopenText}`,
    currentWindow: null,
    canCancelUntil: null,
    todayDateStr: dateStr,
    todayDay: dayName,
    activeWindows: windows,
    nextWindow,
  };
}
