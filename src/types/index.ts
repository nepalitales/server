import type { ObjectId } from "mongodb";

/** Days of the week - lowercase, consistent across all APIs */
export type DayOfWeek =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

/** Admin document stored in MongoDB */
export interface AdminDoc {
  _id?: ObjectId;
  id: string;
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Session document stored in MongoDB with TTL index */
export interface SessionDoc {
  _id?: ObjectId;
  token: string;
  adminId: string;
  createdAt: Date;
  expiresAt: Date;
}

/** Category document */
export interface CategoryDoc {
  _id?: ObjectId;
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export type FoodType = "veg" | "non-veg";

/** Product document stored in MongoDB */
export interface ProductDoc {
  _id?: ObjectId;
  id: string;
  name: string;
  description: string;
  price: number;
  image: string;
  imagePublicId?: string;
  categoryId: string;
  categorySlug: string;
  type: FoodType;
  quantity?: string; // e.g. "6 pcs", "2 pcs"
  isAvailable: boolean;
  isTestOnly?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Order window time slot */
export interface TimeWindow {
  start: string; // "HH:mm" 24-hour format
  end: string;
  maxOrders?: number; // Maximum orders kitchen accepts during this window (defaults to 50)
}

/** Order window document per day */
export interface OrderWindowDoc {
  _id?: ObjectId;
  day: DayOfWeek;
  enabled: boolean;
  windows: TimeWindow[];
  updatedAt: Date;
}

/** Dispatch time slot configuration */
export interface DispatchSlot {
  id: string; // unique identifier (e.g. "slot_1200_1300")
  start: string; // "HH:mm" 24-hour format
  end: string;
  label: string; // "12:00 PM - 01:00 PM"
  maxCapacity: number; // max concurrent orders the kitchen can take
  isActive: boolean; // toggle to emergency disable specific slot
}

/** Dispatch window document per day */
export interface DispatchWindowDoc {
  _id?: ObjectId;
  day: DayOfWeek;
  enabled: boolean;
  slots: DispatchSlot[];
  updatedAt: Date;
}

/** Atomic capacity bucket per (date, slot) to completely prevent race conditions */
export interface DispatchSlotBucketDoc {
  _id: string; // `${dateStr}_${slotId}` e.g. "2026-10-10_slot_1200_1300"
  date: string; // "YYYY-MM-DD" in IST
  day: DayOfWeek;
  slotId: string;
  start: string;
  end: string;
  label: string;
  maxCapacity: number;
  confirmedOrders: string[]; // array of confirmed order IDs
  activeHolds: Array<{
    orderId: string;
    expiresAt: Date;
    createdAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

/** Weekly off document - single document with array of days */
export interface WeeklyOffDoc {
  _id?: ObjectId;
  days: DayOfWeek[];
  updatedAt: Date;
}

/** Holiday document */
export interface HolidayDoc {
  _id?: ObjectId;
  id: string;
  date: string; // "YYYY-MM-DD"
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Client user document */
export interface ClientUserDoc {
  _id?: ObjectId;
  id: string; // "user_<id>"
  phone?: string; // E.164 formatted without + (e.g. "919876543210")
  email?: string;
  username?: string; // Client display name
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Client session document */
export interface ClientSessionDoc {
  _id?: ObjectId;
  token: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

/** Client OTP document */
export interface ClientOtpDoc {
  _id?: ObjectId;
  identifier: string; // email or normalized phone
  phone?: string;
  email?: string;
  otpHash: string;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  requestHistory?: Date[];
  lastIp?: string;
}

/** Borzo formatted address representation for direct courier booking */
export interface BorzoAddressFormat {
  address: string; // Full street address string for Borzo geocoding
  note: string; // Floor, apt, landmark formatted for the courier
  latitude?: string;
  longitude?: string;
}

/** Client delivery address document stored in MongoDB */
export interface ClientAddressDoc {
  _id?: ObjectId;
  id: string; // "addr_<id>"
  userId: string; // references ClientUserDoc.id
  label: string; // "Home" | "Work" | "Other"
  flatNumber?: string; // Flat / House / Door number
  wing?: string; // Wing / Tower / Block
  addressLine1?: string; // Building / society name
  addressLine2?: string; // Area / Locality / Sector
  street: string; // Main road, area, street name
  building?: string; // Building / house name or number
  floor?: string; // Floor number
  apartment?: string; // Flat / apartment / door number
  landmark?: string; // Nearby landmark
  city?: string; // City name
  pincode?: string; // 6-digit postal code
  latitude?: string; // GPS latitude
  longitude?: string; // GPS longitude
  isDefault: boolean; // Primary delivery address
  createdAt: Date;
  updatedAt: Date;
}

// ─── Order Lifecycle & Documents ─────────────────────────────────

export type OrderType = "pickup" | "delivery";

export type OrderStatus =
  | "pending_payment"        // checkout created, awaiting Razorpay payment
  | "placed"                 // payment verified, customer can cancel before window ends
  | "preparing"              // ordering window closed, food is being cooked in kitchen
  | "ready"                  // food ready: pickup customers collect; delivery triggers Borzo
  | "porter_booked"          // Borzo porter booked, courier assigned (delivery only)
  | "porter_failed"          // Borzo booking failed, retry or call customer (delivery only)
  | "out_for_delivery"       // courier picked up food, on way to customer
  | "delivered"              // delivered or collected at kitchen
  | "cancelled_by_customer"  // cancelled before window ended, auto-refund initiated
  | "cancelled_by_admin"     // cancelled by kitchen, manual refund processed
  | "expired";               // checkout timed out without payment, slot hold released

export interface OrderItemAddon {
  addonId: string;
  name: string;
  price: number;
  quantity: number;
  subtotal: number;
  image?: string;
}

export interface OrderItem {
  productId: string;
  productName: string;
  price: number;
  quantity: number;
  subtotal: number;
  image?: string;
  kind?: "product" | "addon";
  addonId?: string;
  addons?: OrderItemAddon[];
}

export interface OrderPaymentInfo {
  provider: "razorpay";
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  status: "pending" | "paid" | "failed" | "refunded";
  paidAt?: Date;
}

export interface OrderRefundInfo {
  status: "none" | "initiated" | "pending" | "refunded" | "failed" | "declined";
  amount?: number;
  type?: "full" | "partial" | "decline";
  reason?: string;
  razorpayRefundId?: string;
  refundedAt?: Date;
  notes?: string;
  error?: string;
}

export interface OrderBorzoInfo {
  borzoOrderId?: number;
  borzoOrderName?: string;
  trackingUrl?: string;
  status?: string;
  deliveryFee?: string;
  error?: string;
  updatedAt?: Date;
}

export interface OrderTimelineEntry {
  status: OrderStatus;
  timestamp: Date;
  note?: string;
}

export interface OrderDoc {
  _id?: ObjectId;
  id: string; // "order_<nanoid>"
  orderNumber: string; // e.g. "NT-1001"
  userId: string;
  customer: {
    name: string;
    phone: string;
    email?: string;
  };
  deliveryAddress: {
    id?: string;
    label?: string;
    flatNumber?: string;
    wing?: string;
    addressLine1?: string;
    addressLine2?: string;
    street: string;
    building?: string;
    floor?: string;
    apartment?: string;
    landmark?: string;
    city?: string;
    pincode?: string;
    latitude?: string;
    longitude?: string;
    borzoFormat: BorzoAddressFormat;
  };
  orderType: OrderType;
  items: OrderItem[];
  itemTotal: number;
  deliveryFee: number;
  discount: number;
  totalAmount: number;
  notes?: string;
  status: OrderStatus;
  canCustomerCancelUntil: Date;
  dispatchDate?: string; // "YYYY-MM-DD" in IST
  dispatchSlot?: {
    id: string;
    start: string;
    end: string;
    label: string;
  };
  slotHoldExpiresAt?: Date;
  payment: OrderPaymentInfo;
  refund?: OrderRefundInfo;
  borzo?: OrderBorzoInfo;
  timeline: OrderTimelineEntry[];
  createdAt: Date;
  updatedAt: Date;
}

/** Admin-managed pickup / delivery checkout settings */
export interface OrderSettingsDoc {
  _id?: ObjectId;
  docId: string;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  deliveryFee: number;
  pickupInstructions: string;
  updatedAt: Date;
}

/** Menu add-on (extras) document stored in MongoDB; images live on Cloudinary */
export interface AddonDoc {
  _id?: ObjectId;
  id: string;
  name: string;
  price: number;
  image: string;
  imagePublicId?: string;
  isAvailable: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** FAQ document stored in MongoDB */
export interface FaqDoc {
  _id?: ObjectId;
  id: string;
  question: string;
  answer: string;
  category?: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}



