import type { OrderDoc, OrderBorzoInfo } from "../types";

export interface DispatchPorterParams {
  order: OrderDoc;
  kitchenAddress: string;
  kitchenPhone: string;
  borzoServiceUrl: string;
  borzoServiceKey: string;
  isDevelopment?: boolean;
}

export interface DispatchPorterResult {
  success: boolean;
  borzoInfo?: OrderBorzoInfo;
  error?: string;
  hint?: string;
}

/**
 * Dispatches an automated Porter delivery booking for an order via the Borzo service.
 *
 * Point 0: Cloud Kitchen Pickup Location
 * Point 1: Customer Delivery Address
 */
export async function dispatchBorzoPorter(
  params: DispatchPorterParams,
): Promise<DispatchPorterResult> {
  const { order, kitchenAddress, kitchenPhone, borzoServiceUrl, borzoServiceKey, isDevelopment } = params;
  const serviceUrl = (borzoServiceUrl || "http://127.0.0.1:8788").trim().replace(/\/$/, "");
  const serviceKey = borzoServiceKey || "dev-internal-key-change-me";

  try {
    // 1. Create order in Borzo service if not already existing
    const createRes = await fetch(`${serviceUrl}/api/delivery/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": serviceKey,
      },
      body: JSON.stringify({
        customerName: order.customer.name,
        customerPhone: order.customer.phone,
        kitchenAddress,
        kitchenPhone,
        deliveryAddress: {
          street: order.deliveryAddress.street,
          building: order.deliveryAddress.building,
          floor: order.deliveryAddress.floor,
          apartment: order.deliveryAddress.apartment,
          landmark: order.deliveryAddress.landmark,
          latitude: order.deliveryAddress.latitude,
          longitude: order.deliveryAddress.longitude,
        },
        items: order.items.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
          unitPrice: i.price,
        })),
        totalAmount: order.totalAmount,
        notes: order.notes,
      }),
    });

    const createData = (await createRes.json()) as any;

    if (!createRes.ok || !createData.success || !createData.order?.id) {
      const err = createData?.message || "Failed to create order in Borzo service";
      console.error("Borzo service create order failed:", createData);

      if (isDevelopment) {
        // Fallback simulation in dev when borzo-service is offline
        const mockBorzoId = Math.floor(10000 + Math.random() * 90000);
        return {
          success: true,
          borzoInfo: {
            borzoOrderId: mockBorzoId,
            borzoOrderName: String(mockBorzoId),
            trackingUrl: `https://apitest.borzodelivery.com/in/track/SIM_${mockBorzoId}`,
            status: "available",
            deliveryFee: "75.00",
            updatedAt: new Date(),
          },
        };
      }

      return {
        success: false,
        error: err,
        hint: "Check if borzo-service is running and accessible.",
      };
    }

    const borzoServiceOrderId = createData.order.id;

    // 2. Trigger booking
    const bookRes = await fetch(`${serviceUrl}/api/delivery/orders/${borzoServiceOrderId}/book`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": serviceKey,
      },
    });

    const bookData = (await bookRes.json()) as any;

    if (!bookRes.ok || !bookData.success) {
      const err = bookData?.message || "Borzo booking failed";
      return {
        success: false,
        error: err,
        hint: "Borzo courier booking rejected. You can click 'Retry Porter' or call customer.",
      };
    }

    const booking = bookData.booking;
    return {
      success: true,
      borzoInfo: {
        borzoOrderId: booking.borzoOrderId,
        borzoOrderName: booking.borzoOrderName,
        trackingUrl: booking.trackingUrl,
        status: booking.borzoStatus || "new",
        deliveryFee: String(booking.deliveryFee || "0"),
        updatedAt: new Date(),
      },
    };
  } catch (error: any) {
    console.error("Failed to connect to Borzo service:", error);

    if (isDevelopment) {
      // In local development when standalone Borzo worker isn't currently booted
      const mockBorzoId = Math.floor(10000 + Math.random() * 90000);
      return {
        success: true,
        borzoInfo: {
          borzoOrderId: mockBorzoId,
          borzoOrderName: String(mockBorzoId),
          trackingUrl: `https://apitest.borzodelivery.com/in/track/DEV_${mockBorzoId}`,
          status: "available",
          deliveryFee: "75.00",
          updatedAt: new Date(),
        },
      };
    }

    return {
      success: false,
      error: `Could not reach Borzo delivery service: ${error.message}`,
      hint: "Ensure borzo-service on port 8788 is active.",
    };
  }
}
