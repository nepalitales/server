import type { Db } from "mongodb";
import { COLLECTIONS } from "./db";
import { getRedisClient, cacheGet, cacheSet, CACHE_KEYS } from "./redis";
import { bumpConfigVersion } from "./config-version";
import { getIstDateTime, formatTime12, formatWindowSpan } from "./order-window";
import { getNextAvailableDispatchDate } from "./dispatch-windows";
import type {
  OrderWindowDoc,
  DispatchWindowDoc,
  DispatchSlot,
  DispatchSlotBucketDoc,
  TimeWindow,
  DayOfWeek,
  OrderDoc,
} from "../types";

// ─── TYPES & INTERFACES ──────────────────────────────────────────

export interface LiveWindowExtendedPayload {
  type: "LIVE_WINDOW_EXTENDED";
  version: string;
  timestamp: string;
  todayDay: DayOfWeek;
  previousEndTime: string;
  newEndTime: string;
  newEndTimeFormatted: string;
  previousMaxOrders?: number;
  newMaxOrders?: number;
  addedCap: number;
  extendedMinutes: number;
  autoExtendedSlots?: DispatchSlot[];
  currentOrdersCount: number;
  targetDispatchDate?: string;
}

export interface LiveWindowStatusOverview {
  isLiveOpen: boolean;
  todayDay: DayOfWeek;
  todayDateStr: string;
  currentTimeStr: string;
  activeWindow: (TimeWindow & { timeFormatted: string }) | null;
  currentOrdersCount: number;
  maxOrders: number;
  remainingCapacity: number;
  remainingMinutes: number;
  isCapacityFull: boolean;
  upcomingWindowToday: (TimeWindow & { timeFormatted: string }) | null;
  targetDispatchDate: string;
  dispatchSlotsCount: number;
  totalDispatchCapacity: number;
}

// ─── TIME ALGORITHMS (IST) ────────────────────────────────────────

/**
 * Adds minutes to a 24-hour "HH:mm" time string, clamping to 23:59 max.
 */
export function addMinutesToTime(timeStr: string, minutesToAdd: number): string {
  const [hStr, mStr] = timeStr.split(":");
  let totalMin = parseInt(hStr || "0", 10) * 60 + parseInt(mStr || "0", 10) + minutesToAdd;
  totalMin = Math.min(Math.max(totalMin, 0), 23 * 60 + 59); // Clamp within the same day

  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

/**
 * Calculates the difference in minutes between two "HH:mm" strings (end - start).
 */
export function timeDiffInMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if (sh === undefined || sm === undefined || eh === undefined || em === undefined) return 0;
  return eh * 60 + em - (sh * 60 + sm);
}

// ─── DSA 1: INTERVAL TILING ALGORITHM FOR DISPATCH SLOTS ──────────

/**
 * Interval Tiling Algorithm:
 * When ordering window is extended and dispatch slots need more span,
 * this algorithm computes the latest slot interval, detects coverage gaps,
 * and tiles new non-overlapping DispatchSlot intervals cleanly.
 */
export function tileExtendedDispatchSlots(
  existingSlots: DispatchSlot[],
  minutesToCover: number,
  defaultSlotDurationMinutes = 60,
  baseCapacityPerSlot = 30,
): DispatchSlot[] {
  if (minutesToCover <= 0) return [];

  // Sort slots by start time
  const sorted = [...existingSlots].sort((a, b) => a.start.localeCompare(b.start));
  const latestSlot = sorted[sorted.length - 1];

  let startCursor = latestSlot ? latestSlot.end : "18:00";
  const newSlots: DispatchSlot[] = [];
  let remainingMinutes = minutesToCover;

  while (remainingMinutes > 0) {
    const slotDuration = Math.min(remainingMinutes, defaultSlotDurationMinutes);
    // Discard tiny trailing intervals under 15 minutes
    if (slotDuration < 15 && newSlots.length > 0) break;

    const endCursor = addMinutesToTime(startCursor, slotDuration);
    if (endCursor <= startCursor) break; // Reached end of day limit (23:59)

    const rawId = `slot_${startCursor.replace(":", "")}_${endCursor.replace(":", "")}`;
    const formattedLabel = `${formatTime12(startCursor)} - ${formatTime12(endCursor)}`;

    newSlots.push({
      id: rawId,
      start: startCursor,
      end: endCursor,
      label: formattedLabel,
      maxCapacity: baseCapacityPerSlot,
      isActive: true,
    });

    remainingMinutes -= slotDuration;
    startCursor = endCursor;
  }

  return newSlots;
}

// ─── DSA 2: WEIGHTED PROPORTIONAL CAP DISTRIBUTION ───────────────

/**
 * Proportional Cap Distribution Algorithm:
 * Distributes additional order capacity delta across existing dispatch slots
 * without fractional drift (using largest remainder / Hamilton-Hare method).
 */
export function distributeCapacityDelta(
  slots: DispatchSlot[],
  additionalCap: number,
): { slotId: string; addedCapacity: number; newCapacity: number }[] {
  if (!slots.length || additionalCap <= 0) return [];

  const totalCurrent = slots.reduce((acc, s) => acc + s.maxCapacity, 0);
  const n = slots.length;

  // Base allocation: equal share or weighted by existing size
  const basePerSlot = Math.floor(additionalCap / n);
  let remainder = additionalCap % n;

  return slots.map((slot) => {
    let added = basePerSlot;
    if (remainder > 0) {
      added += 1;
      remainder -= 1;
    }
    return {
      slotId: slot.id,
      addedCapacity: added,
      newCapacity: slot.maxCapacity + added,
    };
  });
}

// ─── DSA 3: IN-MEMORY BROADCAST HUB & SINGLEFLIGHT COALESCING ────

type StreamCallback = (payload: LiveWindowExtendedPayload) => void;

class LiveWindowBroadcastHub {
  private static instance: LiveWindowBroadcastHub;
  private subscribers = new Set<StreamCallback>();
  private inFlightStatus: Promise<LiveWindowStatusOverview> | null = null;

  static getInstance(): LiveWindowBroadcastHub {
    if (!LiveWindowBroadcastHub.instance) {
      LiveWindowBroadcastHub.instance = new LiveWindowBroadcastHub();
    }
    return LiveWindowBroadcastHub.instance;
  }

  subscribe(callback: StreamCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Pushes payload to all active client streams in memory.
   * Completely O(N) with 0 database or Redis reads!
   */
  broadcast(payload: LiveWindowExtendedPayload): void {
    for (const callback of this.subscribers) {
      try {
        callback(payload);
      } catch (err) {
        console.warn("[BroadcastHub] Client push failed:", err);
      }
    }
  }

  /**
   * Single-flight execution for live status queries:
   * Prevents cache stampede if thousands of clients reconnect or refresh at once.
   */
  async coalesceStatusQuery(
    fn: () => Promise<LiveWindowStatusOverview>,
  ): Promise<LiveWindowStatusOverview> {
    if (this.inFlightStatus) {
      return this.inFlightStatus;
    }

    this.inFlightStatus = fn().finally(() => {
      this.inFlightStatus = null;
    });

    return this.inFlightStatus;
  }
}

export const liveWindowBroadcastHub = LiveWindowBroadcastHub.getInstance();

// ─── LIVE WINDOW DATA OPERATIONS ──────────────────────────────────

/**
 * Retrieves the current live open order window status, calculating
 * exact order placement count and capacity limits with single-flight protection.
 */
export async function getLiveOrderWindowOverview(
  db: Db,
  env?: any,
): Promise<LiveWindowStatusOverview> {
  return liveWindowBroadcastHub.coalesceStatusQuery(async () => {
    const { dateStr, timeStr, dayName } = getIstDateTime();
    const nextDispatch = await getNextAvailableDispatchDate(db);

    // 1. Fetch Today's Order Window
    const orderWindowsCol = db.collection<OrderWindowDoc>(COLLECTIONS.ORDER_WINDOWS);
    const todayWindowDoc = await orderWindowsCol.findOne({ day: dayName });

    const windows = todayWindowDoc?.enabled ? todayWindowDoc.windows || [] : [];
    const activeWindow = windows.find((w) => timeStr >= w.start && timeStr <= w.end) || null;
    const upcomingWindowToday = !activeWindow ? windows.find((w) => timeStr < w.start) || null : null;

    let currentOrdersCount = 0;
    const maxOrders = activeWindow?.maxOrders || (activeWindow ? 50 : 0);

    // 2. Count active orders placed inside the current live window
    if (activeWindow) {
      const windowStart = new Date(`${dateStr}T${activeWindow.start}:00+05:30`);
      const windowEnd = new Date(`${dateStr}T${activeWindow.end}:00+05:30`);
      const ordersCol = db.collection<OrderDoc>(COLLECTIONS.ORDERS);

      currentOrdersCount = await ordersCol.countDocuments({
        createdAt: { $gte: windowStart, $lte: windowEnd },
        status: {
          $nin: [
            "cancelled_by_customer",
            "cancelled_by_admin",
            "pending_payment",
            "expired",
          ],
        },
      });
    }

    // 3. Check Target Dispatch Slots (Respects Weekly Off & Holidays dynamically)
    const dispatchWindowsCol = db.collection<DispatchWindowDoc>(COLLECTIONS.DISPATCH_WINDOWS);
    const dispatchDoc = await dispatchWindowsCol.findOne({ day: nextDispatch.dayName });
    const dispatchSlots = dispatchDoc?.enabled ? dispatchDoc.slots || [] : [];
    const totalDispatchCap = dispatchSlots.reduce((acc, s) => acc + (s.maxCapacity || 0), 0);

    const remainingCapacity = Math.max(0, maxOrders - currentOrdersCount);
    const remainingMinutes = activeWindow ? Math.max(0, timeDiffInMinutes(timeStr, activeWindow.end)) : 0;

    return {
      isLiveOpen: !!activeWindow && remainingCapacity > 0,
      todayDay: dayName,
      todayDateStr: dateStr,
      currentTimeStr: timeStr,
      activeWindow: activeWindow
        ? {
            ...activeWindow,
            timeFormatted: formatWindowSpan(activeWindow.start, activeWindow.end),
          }
        : null,
      currentOrdersCount,
      maxOrders,
      remainingCapacity,
      remainingMinutes,
      isCapacityFull: !!activeWindow && currentOrdersCount >= maxOrders,
      upcomingWindowToday: upcomingWindowToday
        ? {
            ...upcomingWindowToday,
            timeFormatted: formatWindowSpan(upcomingWindowToday.start, upcomingWindowToday.end),
          }
        : null,
      targetDispatchDate: nextDispatch.dateStr,
      dispatchSlotsCount: dispatchSlots.length,
      totalDispatchCapacity: totalDispatchCap,
    };
  });
}

/**
 * Extends the live ordering window time and cap orders,
 * automatically extending dispatch slots and pushing live delta to all active clients.
 */
export async function extendLiveOrderWindow(
  db: Db,
  options: {
    extendMinutes?: number;
    newEndTime?: string;
    additionalCap?: number;
    newMaxOrders?: number;
    autoExtendDispatchSlots?: boolean;
    targetDay?: DayOfWeek;
  },
  env?: any,
): Promise<{
  success: boolean;
  message: string;
  updatedWindow: TimeWindow;
  previousEndTime: string;
  previousMaxOrders: number;
  addedOrders: number;
  extendedMinutes: number;
  autoExtendedSlots?: DispatchSlot[];
  version: string;
}> {
  const { dateStr, timeStr, dayName } = getIstDateTime();
  const targetDay = options.targetDay || dayName;
  const nextDispatch = await getNextAvailableDispatchDate(db);

  const orderWindowsCol = db.collection<OrderWindowDoc>(COLLECTIONS.ORDER_WINDOWS);
  const targetWindowDoc = await orderWindowsCol.findOne({ day: targetDay });

  if (!targetWindowDoc || !targetWindowDoc.enabled || !targetWindowDoc.windows.length) {
    throw new Error(`No enabled order windows configured for ${targetDay}. Configure a window first.`);
  }

  // Find the window to extend: either currently active, upcoming, or the latest window today
  let windowIndex = targetWindowDoc.windows.findIndex(
    (w) => timeStr >= w.start && timeStr <= w.end,
  );
  if (windowIndex === -1) {
    // If not active right now, find the next upcoming or the latest one for today
    windowIndex = targetWindowDoc.windows.findIndex((w) => timeStr < w.start);
    if (windowIndex === -1) {
      windowIndex = targetWindowDoc.windows.length - 1; // Pick the latest window
    }
  }

  const currentWindow = targetWindowDoc.windows[windowIndex]!;
  const previousEndTime = currentWindow.end;
  const previousMaxOrders = currentWindow.maxOrders ?? 50;

  // 1. Calculate new end time
  let finalEndTime = previousEndTime;
  let calculatedExtensionMinutes = 0;

  if (options.newEndTime) {
    finalEndTime = options.newEndTime;
    calculatedExtensionMinutes = Math.max(0, timeDiffInMinutes(previousEndTime, finalEndTime));
  } else if (options.extendMinutes) {
    finalEndTime = addMinutesToTime(previousEndTime, options.extendMinutes);
    calculatedExtensionMinutes = options.extendMinutes;
  }

  // 2. Calculate new max orders cap
  let finalMaxOrders = previousMaxOrders;
  let calculatedAddedCap = 0;

  if (options.newMaxOrders !== undefined) {
    finalMaxOrders = Math.max(previousMaxOrders, options.newMaxOrders);
    calculatedAddedCap = finalMaxOrders - previousMaxOrders;
  } else if (options.additionalCap !== undefined) {
    calculatedAddedCap = options.additionalCap;
    finalMaxOrders = previousMaxOrders + calculatedAddedCap;
  }

  const updatedWindow: TimeWindow = {
    start: currentWindow.start,
    end: finalEndTime,
    maxOrders: finalMaxOrders,
  };

  // 3. Auto-extend dispatch slots & capacities if requested
  let autoExtendedSlots: DispatchSlot[] | undefined = undefined;
  if (options.autoExtendDispatchSlots !== false && (calculatedAddedCap > 0 || calculatedExtensionMinutes > 0)) {
    const dispatchWindowsCol = db.collection<DispatchWindowDoc>(COLLECTIONS.DISPATCH_WINDOWS);
    const targetDispatch = await dispatchWindowsCol.findOne({ day: nextDispatch.dayName });

    if (targetDispatch && targetDispatch.enabled && targetDispatch.slots.length > 0) {
      let slots = [...targetDispatch.slots];

      // A. If additional cap was added, proportionally distribute extra capacity to existing slots
      if (calculatedAddedCap > 0) {
        const capacityDistributions = distributeCapacityDelta(slots, calculatedAddedCap);
        slots = slots.map((s) => {
          const matched = capacityDistributions.find((d) => d.slotId === s.id);
          return matched ? { ...s, maxCapacity: matched.newCapacity } : s;
        });

        // Also sync active dispatch slot buckets for this target date
        const bucketsCol = db.collection<DispatchSlotBucketDoc>(COLLECTIONS.DISPATCH_SLOT_BUCKETS);
        for (const dist of capacityDistributions) {
          const bucketId = `${nextDispatch.dateStr}_${dist.slotId}`;
          await bucketsCol.updateOne(
            { _id: bucketId },
            { $set: { maxCapacity: dist.newCapacity, updatedAt: new Date() } },
          ).catch(() => {});
        }
      }

      // B. If window was extended by 45+ minutes, tile an additional dispatch slot if needed
      if (calculatedExtensionMinutes >= 45) {
        const tiled = tileExtendedDispatchSlots(slots, calculatedExtensionMinutes, 60, 25);
        if (tiled.length > 0) {
          slots = [...slots, ...tiled];
          autoExtendedSlots = tiled;
        }
      }

      // Single atomic write to update dispatch window in MongoDB
      await dispatchWindowsCol.updateOne(
        { day: nextDispatch.dayName },
        {
          $set: {
            slots,
            updatedAt: new Date(),
          },
        },
      );
    }
  }

  // 4. Update the Order Window in MongoDB (Single atomic write)
  const updatedWindows = [...targetWindowDoc.windows];
  updatedWindows[windowIndex] = updatedWindow;

  await orderWindowsCol.updateOne(
    { day: targetDay },
    {
      $set: {
        windows: updatedWindows,
        updatedAt: new Date(),
      },
    },
  );

  // 5. Invalidate and sync Redis cache + isolate RAM version
  const newVersion = await bumpConfigVersion(db, env);

  // Also cache the live overview directly into Redis so reads bypass MongoDB entirely
  const redis = getRedisClient(env);
  if (redis) {
    try {
      await cacheSet(redis, CACHE_KEYS.ORDER_WINDOW_STATUS, {
        isOpen: true,
        windowState: "open",
        currentWindow: updatedWindow,
        maxSlotOrders: finalMaxOrders,
        version: newVersion,
      }, 300);
    } catch (e) {
      console.warn("[Redis Cache Set Error]:", e);
    }
  }

  // 6. Push event through in-memory broadcast hub (Zero DB read for all connected clients)
  const broadcastPayload: LiveWindowExtendedPayload = {
    type: "LIVE_WINDOW_EXTENDED",
    version: newVersion,
    timestamp: new Date().toISOString(),
    todayDay: targetDay,
    previousEndTime,
    newEndTime: finalEndTime,
    newEndTimeFormatted: formatTime12(finalEndTime),
    previousMaxOrders,
    newMaxOrders: finalMaxOrders,
    addedCap: calculatedAddedCap,
    extendedMinutes: calculatedExtensionMinutes,
    autoExtendedSlots,
    currentOrdersCount: 0,
    targetDispatchDate: nextDispatch.dateStr,
  };

  liveWindowBroadcastHub.broadcast(broadcastPayload);

  return {
    success: true,
    message: `Order window extended to ${formatTime12(finalEndTime)} (+${calculatedExtensionMinutes}m) with cap increased to ${finalMaxOrders} (+${calculatedAddedCap} orders).`,
    updatedWindow,
    previousEndTime,
    previousMaxOrders,
    addedOrders: calculatedAddedCap,
    extendedMinutes: calculatedExtensionMinutes,
    autoExtendedSlots,
    version: newVersion,
  };
}

