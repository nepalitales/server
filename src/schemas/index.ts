import { z } from "zod";

/** Valid days of the week */
export const DAYS_OF_WEEK = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export const dayOfWeekSchema = z.enum(DAYS_OF_WEEK);

// ─── Auth Schemas ────────────────────────────────────────────────

export const loginSchema = z.object({
  identifier: z
    .string()
    .min(1, "Identifier is required")
    .refine(
      (val) => {
        // Must be a valid email or phone number
        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
        const isPhone = /^\+?\d{10,15}$/.test(val.replace(/[\s-]/g, ""));
        return isEmail || isPhone;
      },
      { message: "Must be a valid email address or phone number" },
    ),
  password: z
    .string()
    .min(1, "Password is required"),
});

// ─── Category Schemas ────────────────────────────────────────────

export const createCategorySchema = z.object({
  name: z
    .string()
    .min(1, "Category name is required")
    .max(100, "Category name must be 100 characters or less")
    .trim(),
  displayOrder: z
    .number()
    .int("Display order must be an integer")
    .min(0, "Display order must be 0 or greater")
    .optional()
    .default(0),
});

export const updateCategorySchema = z.object({
  name: z
    .string()
    .min(1, "Category name is required")
    .max(100, "Category name must be 100 characters or less")
    .trim()
    .optional(),
  displayOrder: z
    .number()
    .int("Display order must be an integer")
    .min(0, "Display order must be 0 or greater")
    .optional(),
});

// ─── Product Schemas ─────────────────────────────────────────────

export const foodTypeSchema = z.enum(["veg", "non-veg"]);

export const createProductSchema = z.object({
  name: z
    .string()
    .min(1, "Product name is required")
    .max(200, "Product name must be 200 characters or less")
    .trim(),
  description: z
    .string()
    .min(1, "Description is required")
    .max(2000, "Description must be 2000 characters or less")
    .trim(),
  price: z
    .number()
    .positive("Price must be greater than 0")
    .max(100_000, "Price must be 100,000 or less"),
  image: z
    .string()
    .min(1, "Image is required"),
  categoryId: z
    .string()
    .min(1, "Category ID is required"),
  type: z
    .enum(["veg", "non-veg"])
    .optional()
    .default("veg"),
  quantity: z
    .string()
    .max(50, "Quantity must be 50 characters or less")
    .trim()
    .optional(),
  isAvailable: z
    .boolean()
    .optional()
    .default(true),
});

export const updateProductSchema = z.object({
  name: z
    .string()
    .min(1, "Product name is required")
    .max(200, "Product name must be 200 characters or less")
    .trim()
    .optional(),
  description: z
    .string()
    .min(1, "Description is required")
    .max(2000, "Description must be 2000 characters or less")
    .trim()
    .optional(),
  price: z
    .number()
    .positive("Price must be greater than 0")
    .max(100_000, "Price must be 100,000 or less")
    .optional(),
  image: z
    .string()
    .min(1, "Image URL is required")
    .optional(),
  categoryId: z
    .string()
    .min(1, "Category ID is required")
    .optional(),
  type: z
    .enum(["veg", "non-veg"])
    .optional(),
  quantity: z
    .string()
    .max(50, "Quantity must be 50 characters or less")
    .trim()
    .optional(),
  isAvailable: z
    .boolean()
    .optional(),
});

// ─── Order Window Schemas ────────────────────────────────────────

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const timeWindowSchema = z
  .object({
    start: z
      .string()
      .regex(timeRegex, "Start time must be in HH:mm format (24-hour)"),
    end: z
      .string()
      .regex(timeRegex, "End time must be in HH:mm format (24-hour)"),
    maxOrders: z
      .number()
      .int("Max orders must be an integer")
      .min(1, "Max orders must be at least 1")
      .max(1000, "Max orders cannot exceed 1000")
      .optional()
      .default(50),
  })
  .refine(
    (tw) => tw.start < tw.end,
    { message: "Start time must be before end time" },
  );

export const updateOrderWindowSchema = z.object({
  enabled: z.boolean(),
  windows: z
    .array(timeWindowSchema)
    .max(10, "Maximum 10 time windows per day"),
});

export const bulkUpdateOrderWindowSchema = z.object({
  days: z.array(dayOfWeekSchema).min(1, "At least one day must be selected").max(7),
  enabled: z.boolean(),
  windows: z
    .array(timeWindowSchema)
    .max(10, "Maximum 10 time windows per day"),
});

export const extendLiveOrderWindowSchema = z
  .object({
    extendMinutes: z
      .number()
      .int("Extension minutes must be an integer")
      .min(1, "Extension minutes must be at least 1")
      .max(720, "Extension minutes cannot exceed 12 hours")
      .optional(),
    newEndTime: z
      .string()
      .regex(timeRegex, "End time must be in HH:mm format (24-hour)")
      .optional(),
    additionalCap: z
      .number()
      .int("Additional capacity must be an integer")
      .min(0, "Additional capacity cannot be negative")
      .max(10000, "Additional capacity cannot exceed 10,000")
      .optional(),
    newMaxOrders: z
      .number()
      .int("Max orders must be an integer")
      .min(1, "Max orders must be at least 1")
      .max(20000, "Max orders cannot exceed 20,000")
      .optional(),
    autoExtendDispatchSlots: z.boolean().default(true),
    targetDay: dayOfWeekSchema.optional(),
  })
  .refine(
    (data) => data.extendMinutes !== undefined || data.newEndTime !== undefined || data.additionalCap !== undefined || data.newMaxOrders !== undefined,
    { message: "At least one extension parameter (time or cap) must be provided" }
  );

// ─── Dispatch Window & Slot Schemas ──────────────────────────────

export const dispatchSlotSchema = z
  .object({
    id: z.string().min(1, "Slot ID is required"),
    start: z
      .string()
      .regex(timeRegex, "Start time must be in HH:mm format (24-hour)"),
    end: z
      .string()
      .regex(timeRegex, "End time must be in HH:mm format (24-hour)"),
    label: z.string().min(1, "Slot label is required"),
    maxCapacity: z
      .number()
      .int("Max capacity must be an integer")
      .min(1, "Max capacity must be at least 1 order")
      .max(200, "Max capacity cannot exceed 200 orders"),
    isActive: z.boolean().default(true),
  })
  .refine(
    (s) => s.start < s.end,
    { message: "Start time must be before end time" },
  );

export const updateDispatchWindowSchema = z.object({
  enabled: z.boolean(),
  slots: z
    .array(dispatchSlotSchema)
    .max(30, "Maximum 30 dispatch slots per day"),
});

export const bulkUpdateDispatchWindowSchema = z.object({
  days: z.array(dayOfWeekSchema).min(1, "At least one day must be selected").max(7),
  enabled: z.boolean(),
  slots: z
    .array(dispatchSlotSchema)
    .max(30, "Maximum 30 dispatch slots per day"),
});

// ─── Weekly Off Schemas ──────────────────────────────────────────

export const updateWeeklyOffSchema = z.object({
  days: z
    .array(dayOfWeekSchema)
    .max(7, "Cannot have more than 7 days"),
});

// ─── Holiday Schemas ─────────────────────────────────────────────

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const createHolidaySchema = z.object({
  date: z
    .string()
    .regex(dateRegex, "Date must be in YYYY-MM-DD format")
    .refine(
      (d) => !isNaN(new Date(d).getTime()),
      { message: "Date must be a valid date" },
    ),
  reason: z
    .string()
    .min(1, "Reason is required")
    .max(500, "Reason must be 500 characters or less")
    .trim(),
});

export const updateHolidaySchema = z.object({
  date: z
    .string()
    .regex(dateRegex, "Date must be in YYYY-MM-DD format")
    .refine(
      (d) => !isNaN(new Date(d).getTime()),
      { message: "Date must be a valid date" },
    )
    .optional(),
  reason: z
    .string()
    .min(1, "Reason is required")
    .max(500, "Reason must be 500 characters or less")
    .trim()
    .optional(),
});

// ─── Client Auth Schemas ──────────────────────────────────────────

export const clientPhoneSchema = z
  .string()
  .min(1, "Phone number is required")
  .transform((val) => val.replace(/[\s\-\+\(\)]/g, ""))
  .refine(
    (val) => /^\d{10,15}$/.test(val),
    "Phone number must be 10 to 15 digits (e.g. 9876543210 or 919876543210)",
  );

export const clientEmailSchema = z
  .string()
  .email("Invalid email address")
  .toLowerCase()
  .trim();

export const requestOtpSchema = z.object({
  email: clientEmailSchema,
});

export const verifyOtpSchema = z.object({
  email: clientEmailSchema,
  otp: z
    .string()
    .min(4, "OTP must be at least 4 digits")
    .max(8, "OTP cannot exceed 8 digits")
    .regex(/^\d+$/, "OTP must contain digits only"),
  username: z
    .string()
    .min(2, "Username must be at least 2 characters")
    .max(50, "Username must be 50 characters or less")
    .trim()
    .optional(),
});

export const updateClientProfileSchema = z.object({
  username: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be 50 characters or less")
    .trim()
    .optional(),
  phone: clientPhoneSchema.optional(),
});

export const setUsernameSchema = z.object({
  username: z
    .string()
    .min(2, "Username must be at least 2 characters")
    .max(50, "Username must be 50 characters or less")
    .trim(),
});

// ─── Client Delivery Address Schemas (Borzo Compatible) ──────────

export const createAddressSchema = z.object({
  label: z
    .string()
    .max(50, "Label must be 50 characters or less")
    .trim()
    .optional()
    .default("Home"),

  /**
   * Specific delivery address components (Zomato / Blinkit / Swiggy standard)
   */
  flatNumber: z
    .string()
    .max(60, "Flat / House number must be 60 characters or less")
    .trim()
    .optional(),

  wing: z
    .string()
    .max(50, "Wing / Tower must be 50 characters or less")
    .trim()
    .optional(),

  addressLine1: z
    .string()
    .max(300, "Address line 1 must be 300 characters or less")
    .trim()
    .optional(),

  addressLine2: z
    .string()
    .max(300, "Address line 2 must be 300 characters or less")
    .trim()
    .optional(),

  /**
   * Main street / road / locality name.
   * Required for Borzo geocoding (can be mapped from addressLine1/addressLine2).
   */
  street: z
    .string()
    .max(350, "Street address must be 350 characters or less")
    .trim()
    .optional(),

  building: z
    .string()
    .max(150, "Building / society name must be 150 characters or less")
    .trim()
    .optional(),

  floor: z
    .string()
    .max(30, "Floor must be 30 characters or less")
    .trim()
    .optional(),

  apartment: z
    .string()
    .max(60, "Apartment / flat number must be 60 characters or less")
    .trim()
    .optional(),

  landmark: z
    .string()
    .max(200, "Landmark must be 200 characters or less")
    .trim()
    .optional(),

  city: z
    .string()
    .max(100, "City must be 100 characters or less")
    .trim()
    .optional()
    .default("Mumbai"),

  pincode: z
    .string()
    .regex(/^\d{6}$/, "Pincode must be a 6-digit postal code")
    .optional(),

  latitude: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, "Latitude must be a valid decimal number")
    .optional(),

  longitude: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, "Longitude must be a valid decimal number")
    .optional(),

  isDefault: z.boolean().optional().default(false),
});

export const updateAddressSchema = createAddressSchema.partial();

// ─── Order Lifecycle Schemas ─────────────────────────────────────

/** Maximum dishes / food items allowed per customer at a time */
export const MAX_DISHES_PER_ORDER = 15;

export const orderTypeSchema = z.enum(["pickup", "delivery"]);

export const orderCartAddonSchema = z.object({
  addonId: z.string().min(1, "Add-on ID is required"),
  quantity: z
    .number()
    .int("Quantity must be an integer")
    .positive("Quantity must be at least 1")
    .max(20, "Add-on quantity cannot exceed 20"),
});

export const orderCartItemSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  quantity: z
    .number()
    .int("Quantity must be an integer")
    .positive("Quantity must be at least 1")
    .max(MAX_DISHES_PER_ORDER, `Quantity cannot exceed ${MAX_DISHES_PER_ORDER} per item`),
  addons: z.array(orderCartAddonSchema).max(20).optional(),
});

export const createOrderSchema = z
  .object({
    orderType: orderTypeSchema,
    addressId: z.string().optional(),
    address: createAddressSchema.optional(),
    dispatchSlotId: z.string().min(1, "Dispatch slot selection is required"),
    dispatchDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Dispatch date must be in YYYY-MM-DD format")
      .optional(),
    items: z
      .array(orderCartItemSchema)
      .min(1, "Cart must contain at least one item"),
    addons: z.array(orderCartAddonSchema).max(20).optional(),
    notes: z.string().max(500, "Notes cannot exceed 500 characters").optional(),
    contactEmail: clientEmailSchema.optional(),
    contactPhone: clientPhoneSchema.optional(),
    customerName: z
      .string()
      .min(2, "Name must be at least 2 characters")
      .max(80)
      .trim()
      .optional(),
  })
  .refine(
    (data) => {
      if (data.orderType === "delivery") {
        return !!data.addressId || !!data.address;
      }
      return true;
    },
    {
      message: "A delivery address is required for delivery orders",
      path: ["addressId"],
    },
  )
  .refine(
    (data) => {
      const totalCount = data.items.reduce((sum, item) => sum + item.quantity, 0);
      return totalCount <= MAX_DISHES_PER_ORDER;
    },
    {
      message: `You cannot order more than ${MAX_DISHES_PER_ORDER} dishes at a time. Please reduce your cart quantity.`,
      path: ["items"],
    },
  );

export const updateOrderSettingsSchema = z.object({
  pickupEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
  deliveryFee: z
    .number()
    .min(0, "Delivery fee cannot be negative")
    .max(5000, "Delivery fee is too high"),
  pickupInstructions: z
    .string()
    .max(500, "Pickup instructions must be 500 characters or less")
    .trim(),
}).refine(
  (data) => data.pickupEnabled || data.deliveryEnabled,
  {
    message: "At least one of pickup or delivery must stay enabled",
    path: ["pickupEnabled"],
  },
);

export const verifyPaymentSchema = z.object({
  orderId: z.string().min(1, "Order ID is required"),
  razorpayOrderId: z.string().min(1, "Razorpay Order ID is required"),
  razorpayPaymentId: z.string().min(1, "Razorpay Payment ID is required"),
  razorpaySignature: z.string().min(1, "Razorpay Signature is required"),
});

export const adminUpdateOrderStatusSchema = z.object({
  status: z.enum([
    "preparing",
    "ready",
    "out_for_delivery",
    "delivered",
  ]),
  note: z.string().max(500).optional(),
  trackingUrl: z.string().max(500).optional(),
});

export const adminCancelOrderSchema = z
  .object({
    reason: z
      .string()
      .min(3, "Cancellation reason is required (at least 3 characters)")
      .max(500, "Reason cannot exceed 500 characters")
      .trim(),
    refundType: z.enum(["full", "partial", "decline"]),
    refundAmount: z
      .number()
      .positive("Refund amount must be greater than 0")
      .optional(),
    notes: z.string().max(500).optional(),
  })
  .refine(
    (data) => {
      if (data.refundType === "partial" && !data.refundAmount) {
        return false;
      }
      return true;
    },
    {
      message: "refundAmount is required when refundType is partial",
      path: ["refundAmount"],
    },
  );

export const reportsQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Month must be in YYYY-MM format")
    .optional(),
  period: z
    .enum(["this_week", "this_month", "last_month", "this_year"])
    .optional(),
});

// ─── FAQ Schemas ─────────────────────────────────────────────────

export const createAddonSchema = z.object({
  name: z
    .string()
    .min(1, "Add-on name is required")
    .max(200, "Add-on name must be 200 characters or less")
    .trim(),
  price: z
    .number()
    .positive("Price must be greater than 0")
    .max(100_000, "Price must be 100,000 or less"),
  image: z.string().min(1, "Image is required"),
  isAvailable: z.boolean().optional().default(true),
  displayOrder: z
    .number()
    .int("Display order must be an integer")
    .min(0, "Display order must be 0 or greater")
    .optional()
    .default(0),
});

export const updateAddonSchema = z.object({
  name: z
    .string()
    .min(1, "Add-on name is required")
    .max(200, "Add-on name must be 200 characters or less")
    .trim()
    .optional(),
  price: z
    .number()
    .positive("Price must be greater than 0")
    .max(100_000, "Price must be 100,000 or less")
    .optional(),
  image: z.string().min(1, "Image URL is required").optional(),
  isAvailable: z.boolean().optional(),
  displayOrder: z
    .number()
    .int("Display order must be an integer")
    .min(0, "Display order must be 0 or greater")
    .optional(),
});

export const createFaqSchema = z.object({
  question: z
    .string()
    .min(1, "Question is required")
    .max(500, "Question must be 500 characters or less")
    .trim(),
  answer: z
    .string()
    .min(1, "Answer is required")
    .max(3000, "Answer must be 3000 characters or less")
    .trim(),
  category: z
    .string()
    .max(100, "Category must be 100 characters or less")
    .trim()
    .optional(),
  displayOrder: z
    .number()
    .int("Display order must be an integer")
    .min(0, "Display order must be 0 or greater")
    .optional()
    .default(0),
  isActive: z.boolean().optional().default(true),
});

export const updateFaqSchema = z.object({
  question: z
    .string()
    .min(1, "Question is required")
    .max(500, "Question must be 500 characters or less")
    .trim()
    .optional(),
  answer: z
    .string()
    .min(1, "Answer is required")
    .max(3000, "Answer must be 3000 characters or less")
    .trim()
    .optional(),
  category: z
    .string()
    .max(100, "Category must be 100 characters or less")
    .trim()
    .optional(),
  displayOrder: z
    .number()
    .int("Display order must be an integer")
    .min(0, "Display order must be 0 or greater")
    .optional(),
  isActive: z.boolean().optional(),
});

export const reorderFaqsSchema = z.object({
  faqIds: z
    .array(z.string().min(1, "ID cannot be empty"))
    .min(1, "faqIds must contain at least one ID"),
});



