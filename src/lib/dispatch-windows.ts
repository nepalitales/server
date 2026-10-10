import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import { getIstDateTime } from "./order-window";
import type {
  DispatchWindowDoc,
  DispatchSlot,
  DispatchSlotBucketDoc,
  DayOfWeek,
  WeeklyOffDoc,
  HolidayDoc,
} from "../types";

const DAYS_ORDER: DayOfWeek[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** Default hold duration for checkout in minutes */
export const SLOT_HOLD_DURATION_MINUTES = 10;

/**
 * Returns tomorrow's date string and day of the week in Indian Standard Time (IST).
 */
export function getTomorrowIstDate(): {
  dateStr: string; // "YYYY-MM-DD"
  dayName: DayOfWeek;
  displayDate: string; // e.g. "Tomorrow, 10 Oct"
} {
  const { now } = getIstDateTime();
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

  const displayDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    month: "short",
    day: "numeric",
  }).format(tomorrow);

  return {
    dateStr: `${year}-${month}-${day}`,
    dayName: weekday,
    displayDate: `Tomorrow, ${displayDate}`,
  };
}

/**
 * Derives day of week from any "YYYY-MM-DD" string in IST.
 */
export function getDayOfWeekForDate(dateStr: string): DayOfWeek {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  return DAYS_ORDER[d.getDay()]!;
}

export interface AvailableSlotItem {
  id: string;
  start: string;
  end: string;
  label: string;
  maxCapacity: number;
  availableCapacity: number;
  confirmedCount: number;
  heldCount: number;
  isFull: boolean;
  isActive: boolean;
}

export interface DispatchAvailabilityResult {
  isOpen: boolean;
  message: string;
  targetDate: string; // "YYYY-MM-DD"
  targetDay: DayOfWeek;
  displayDate: string;
  isHoliday?: boolean;
  holidayReason?: string;
  isWeeklyOff?: boolean;
  slots: AvailableSlotItem[];
}

/**
 * Retrieves available dispatch slots for a given date (defaults to tomorrow in IST).
 * Prunes expired holds and returns real-time available capacity for each slot.
 */
export async function getAvailableDispatchSlots(
  db: Db,
  targetDate?: string,
): Promise<DispatchAvailabilityResult> {
  const tomorrow = getTomorrowIstDate();
  const dateStr = targetDate || tomorrow.dateStr;
  const dayName = getDayOfWeekForDate(dateStr);

  const displayDate =
    dateStr === tomorrow.dateStr
      ? tomorrow.displayDate
      : new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Kolkata",
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(new Date(`${dateStr}T12:00:00+05:30`));

  // 1. Check Holiday for target date
  const holidaysCol = db.collection<HolidayDoc>(COLLECTIONS.HOLIDAYS);
  const holiday = await holidaysCol.findOne({ date: dateStr });
  if (holiday) {
    return {
      isOpen: false,
      message: `Kitchen dispatch is closed on ${dateStr} for holiday: ${holiday.reason}`,
      targetDate: dateStr,
      targetDay: dayName,
      displayDate,
      isHoliday: true,
      holidayReason: holiday.reason,
      slots: [],
    };
  }

  // 2. Check Weekly Off for target day
  const weeklyOffCol = db.collection<WeeklyOffDoc>(COLLECTIONS.WEEKLY_OFF);
  const weeklyOffDoc = await weeklyOffCol.findOne({});
  const offDays = weeklyOffDoc?.days ?? ["monday"];
  if (offDays.includes(dayName)) {
    return {
      isOpen: false,
      message: `Kitchen is closed on ${dayName}s (Weekly Off). No dispatches scheduled.`,
      targetDate: dateStr,
      targetDay: dayName,
      displayDate,
      isWeeklyOff: true,
      slots: [],
    };
  }

  // 3. Find configured dispatch window for that day
  const dispatchWindowsCol = db.collection<DispatchWindowDoc>(COLLECTIONS.DISPATCH_WINDOWS);
  const windowDoc = await dispatchWindowsCol.findOne({ day: dayName });

  if (!windowDoc || !windowDoc.enabled || !windowDoc.slots || windowDoc.slots.length === 0) {
    return {
      isOpen: false,
      message: `No dispatch windows configured for ${dayName}.`,
      targetDate: dateStr,
      targetDay: dayName,
      displayDate,
      slots: [],
    };
  }

  // 4. Fetch buckets and prune expired holds
  const bucketsCol = db.collection<DispatchSlotBucketDoc>(COLLECTIONS.DISPATCH_SLOT_BUCKETS);
  const now = new Date();

  // Clean expired holds across all buckets for this date
  await bucketsCol.updateMany(
    { date: dateStr },
    { $pull: { activeHolds: { expiresAt: { $lt: now } } } as any },
  );

  const buckets = await bucketsCol.find({ date: dateStr }).toArray();
  const bucketMap = new Map(buckets.map((b) => [b.slotId, b]));

  const slotItems: AvailableSlotItem[] = windowDoc.slots.map((slot) => {
    const bucket = bucketMap.get(slot.id);
    const confirmedCount = bucket?.confirmedOrders?.length || 0;
    const heldCount = bucket?.activeHolds?.length || 0;
    const totalBooked = confirmedCount + heldCount;
    const availableCapacity = Math.max(0, slot.maxCapacity - totalBooked);
    const isFull = availableCapacity <= 0;

    return {
      id: slot.id,
      start: slot.start,
      end: slot.end,
      label: slot.label,
      maxCapacity: slot.maxCapacity,
      availableCapacity,
      confirmedCount,
      heldCount,
      isFull,
      isActive: slot.isActive && !isFull,
    };
  });

  return {
    isOpen: true,
    message: `Dispatch slots available for ${displayDate}`,
    targetDate: dateStr,
    targetDay: dayName,
    displayDate,
    slots: slotItems,
  };
}

export type ReservationResult =
  | {
      success: true;
      slot: DispatchSlot;
      dispatchDate: string;
      expiresAt: Date;
    }
  | {
      success: false;
      reason: "SLOT_NOT_FOUND" | "SLOT_INACTIVE" | "SLOT_FULL" | "WINDOW_DISABLED";
      message: string;
    };

/**
 * ATOMIC RESERVATION LOCK:
 * Guarantees zero race conditions by leveraging MongoDB's single-document atomic findOneAndUpdate.
 *
 * Checks capacity and appends a temporary hold in a single atomic database operation.
 * If 100 users race for the last 1 slot at the exact same millisecond:
 * Exactly ONE user will succeed and 99 users will fail with SLOT_FULL.
 */
export async function reserveSlotAtomically(
  db: Db,
  params: {
    dateStr: string; // "YYYY-MM-DD"
    slotId: string;
    orderId: string;
    holdDurationMinutes?: number;
  },
): Promise<ReservationResult> {
  const { dateStr, slotId, orderId, holdDurationMinutes = SLOT_HOLD_DURATION_MINUTES } = params;
  const dayName = getDayOfWeekForDate(dateStr);

  // 1. Verify dispatch window configuration for day
  const dispatchWindowsCol = db.collection<DispatchWindowDoc>(COLLECTIONS.DISPATCH_WINDOWS);
  const windowDoc = await dispatchWindowsCol.findOne({ day: dayName });

  if (!windowDoc || !windowDoc.enabled) {
    return {
      success: false,
      reason: "WINDOW_DISABLED",
      message: `Dispatch is disabled for ${dayName}`,
    };
  }

  const slot = windowDoc.slots?.find((s) => s.id === slotId);
  if (!slot) {
    return {
      success: false,
      reason: "SLOT_NOT_FOUND",
      message: "The requested dispatch time slot does not exist",
    };
  }

  if (!slot.isActive) {
    return {
      success: false,
      reason: "SLOT_INACTIVE",
      message: "The requested dispatch slot has been paused by the kitchen",
    };
  }

  const bucketsCol = db.collection<DispatchSlotBucketDoc>(COLLECTIONS.DISPATCH_SLOT_BUCKETS);
  const bucketId = `${dateStr}_${slotId}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + holdDurationMinutes * 60 * 1000);

  // 2. Ensure bucket exists and prune any expired holds
  await bucketsCol.updateOne(
    { _id: bucketId },
    {
      $pull: { activeHolds: { expiresAt: { $lt: now } } } as any,
      $setOnInsert: {
        _id: bucketId,
        date: dateStr,
        day: dayName,
        slotId: slot.id,
        confirmedOrders: [],
        createdAt: now,
      },
      $set: {
        start: slot.start,
        end: slot.end,
        label: slot.label,
        maxCapacity: slot.maxCapacity,
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  // 3. ATOMIC HOLD CLAIM with $expr:
  // Verifies that (confirmedOrders.length + activeHolds.length) < slot.maxCapacity
  // and pushes the hold atomically in a single write operation.
  const acquired = await bucketsCol.findOneAndUpdate(
    {
      _id: bucketId,
      $expr: {
        $lt: [
          {
            $add: [
              { $size: { $ifNull: ["$confirmedOrders", []] } },
              { $size: { $ifNull: ["$activeHolds", []] } },
            ],
          },
          slot.maxCapacity,
        ],
      },
    },
    {
      $push: {
        activeHolds: {
          orderId,
          expiresAt,
          createdAt: now,
        },
      } as any,
      $set: {
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );

  if (!acquired) {
    // Condition failed: slot reached maxCapacity at this exact millisecond
    return {
      success: false,
      reason: "SLOT_FULL",
      message: `The dispatch slot (${slot.label}) just filled up. Please select another slot.`,
    };
  }

  return {
    success: true,
    slot,
    dispatchDate: dateStr,
    expiresAt,
  };
}

/**
 * Permanently confirms a reserved slot once payment is verified or captured via webhook.
 * Moves the orderId from activeHolds to confirmedOrders.
 */
export async function confirmSlotReservation(
  db: Db,
  params: {
    dateStr: string;
    slotId: string;
    orderId: string;
  },
): Promise<boolean> {
  const { dateStr, slotId, orderId } = params;
  const bucketsCol = db.collection<DispatchSlotBucketDoc>(COLLECTIONS.DISPATCH_SLOT_BUCKETS);
  const bucketId = `${dateStr}_${slotId}`;
  const now = new Date();

  const res = await bucketsCol.updateOne(
    { _id: bucketId },
    {
      $pull: { activeHolds: { orderId } } as any,
      $addToSet: { confirmedOrders: orderId },
      $set: { updatedAt: now },
    },
  );

  return res.modifiedCount > 0;
}

/**
 * Releases a slot reservation if payment fails, customer abandons checkout,
 * or order is cancelled by customer or kitchen.
 */
export async function releaseSlotReservation(
  db: Db,
  params: {
    dateStr: string;
    slotId: string;
    orderId: string;
  },
): Promise<boolean> {
  const { dateStr, slotId, orderId } = params;
  const bucketsCol = db.collection<DispatchSlotBucketDoc>(COLLECTIONS.DISPATCH_SLOT_BUCKETS);
  const bucketId = `${dateStr}_${slotId}`;
  const now = new Date();

  const res = await bucketsCol.updateOne(
    { _id: bucketId },
    {
      $pull: {
        activeHolds: { orderId },
        confirmedOrders: orderId,
      } as any,
      $set: { updatedAt: now },
    },
  );

  return res.modifiedCount > 0;
}

/**
 * Admin Overview: Retrieves detailed capacity utilization for all slots on a specific date.
 */
export async function getSlotUsageOverview(db: Db, targetDate: string) {
  const dayName = getDayOfWeekForDate(targetDate);
  const dispatchWindowsCol = db.collection<DispatchWindowDoc>(COLLECTIONS.DISPATCH_WINDOWS);
  const windowDoc = await dispatchWindowsCol.findOne({ day: dayName });

  const bucketsCol = db.collection<DispatchSlotBucketDoc>(COLLECTIONS.DISPATCH_SLOT_BUCKETS);
  const now = new Date();

  // Prune expired holds
  await bucketsCol.updateMany(
    { date: targetDate },
    { $pull: { activeHolds: { expiresAt: { $lt: now } } } as any },
  );

  const buckets = await bucketsCol.find({ date: targetDate }).toArray();
  const bucketMap = new Map(buckets.map((b) => [b.slotId, b]));

  const slots = (windowDoc?.slots || []).map((slot) => {
    const bucket = bucketMap.get(slot.id);
    const confirmedCount = bucket?.confirmedOrders?.length || 0;
    const heldCount = bucket?.activeHolds?.length || 0;
    const totalBooked = confirmedCount + heldCount;
    const available = Math.max(0, slot.maxCapacity - totalBooked);

    return {
      slotId: slot.id,
      start: slot.start,
      end: slot.end,
      label: slot.label,
      maxCapacity: slot.maxCapacity,
      isActive: slot.isActive,
      confirmedCount,
      heldCount,
      totalBooked,
      availableCapacity: available,
      percentageBooked: Math.min(100, Math.round((totalBooked / slot.maxCapacity) * 100)),
      confirmedOrders: bucket?.confirmedOrders || [],
    };
  });

  return {
    date: targetDate,
    dayName,
    enabled: windowDoc?.enabled ?? false,
    slots,
  };
}
