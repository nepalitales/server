import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { OrderDoc } from "../types";

/**
 * Generates an itemized PDF invoice for a Nepali Tales order using pure pdf-lib.
 * Runs seamlessly in Cloudflare Workers and Node.js without any canvas or native dependencies.
 */
export async function generateOrderInvoicePdf(order: OrderDoc): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  // Standard A4 dimensions: 595.28 x 841.89 points
  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

  // Brand Colors
  const brandRed = rgb(0.85, 0.13, 0.13); // #D92121
  const darkGray = rgb(0.12, 0.12, 0.12);
  const mediumGray = rgb(0.4, 0.4, 0.4);
  const lightGray = rgb(0.9, 0.9, 0.9);
  const lineGray = rgb(0.8, 0.8, 0.8);

  let y = height - 50;

  // 1. Header: Brand & Title
  page.drawText("NEPALI TALES", {
    x: 50,
    y,
    size: 22,
    font: fontBold,
    color: brandRed,
  });

  page.drawText("INVOICE / RECEIPT", {
    x: width - 200,
    y,
    size: 14,
    font: fontBold,
    color: darkGray,
  });

  y -= 16;
  page.drawText("Authentic Himalayan Cloud Kitchen", {
    x: 50,
    y,
    size: 9.5,
    font: fontRegular,
    color: mediumGray,
  });

  const invoiceNumText = `Invoice #: ${order.orderNumber}`;
  page.drawText(invoiceNumText, {
    x: width - 200,
    y,
    size: 10,
    font: fontBold,
    color: darkGray,
  });

  y -= 14;
  page.drawText("Metropolis Rivera, Shop No 10, Kasarvadavali, Opp to Laxmi Narayan Mandir, 400615", {
    x: 50,
    y,
    size: 8.5,
    font: fontRegular,
    color: mediumGray,
  });

  const orderDateFormatted = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(order.createdAt));

  page.drawText(`Date: ${orderDateFormatted}`, {
    x: width - 200,
    y,
    size: 9,
    font: fontRegular,
    color: mediumGray,
  });

  y -= 14;
  page.drawText("Phone: +91 7678097659 | Email: orders@nepalitales.com", {
    x: 50,
    y,
    size: 8.5,
    font: fontRegular,
    color: mediumGray,
  });

  page.drawText(`Status: ${order.status.toUpperCase()}`, {
    x: width - 200,
    y,
    size: 9,
    font: fontBold,
    color: brandRed,
  });

  // Top Divider line
  y -= 16;
  page.drawLine({
    start: { x: 50, y },
    end: { x: width - 50, y },
    thickness: 1.5,
    color: brandRed,
  });

  // 2. Customer & Fulfillment Info Box
  y -= 25;
  const infoBoxY = y;

  // Left Column: Customer details
  page.drawText("BILLED TO:", {
    x: 50,
    y: infoBoxY,
    size: 9,
    font: fontBold,
    color: mediumGray,
  });
  page.drawText(order.customer.name || "Customer", {
    x: 50,
    y: infoBoxY - 14,
    size: 11,
    font: fontBold,
    color: darkGray,
  });
  page.drawText(`Phone: ${order.customer.phone || "N/A"}`, {
    x: 50,
    y: infoBoxY - 28,
    size: 9,
    font: fontRegular,
    color: darkGray,
  });
  if (order.customer.email) {
    page.drawText(`Email: ${order.customer.email}`, {
      x: 50,
      y: infoBoxY - 40,
      size: 9,
      font: fontRegular,
      color: darkGray,
    });
  }

  // Right Column: Delivery / Fulfillment details
  const isPickup = order.orderType === "pickup";
  const fulfillmentX = width / 2 + 20;

  page.drawText("FULFILLMENT & DISPATCH:", {
    x: fulfillmentX,
    y: infoBoxY,
    size: 9,
    font: fontBold,
    color: mediumGray,
  });

  page.drawText(isPickup ? "Mode: Kitchen Pickup (Takeaway)" : "Mode: Doorstep Delivery (Mumbai / Thane)", {
    x: fulfillmentX,
    y: infoBoxY - 14,
    size: 10,
    font: fontBold,
    color: darkGray,
  });

  const slotText = `Slot: ${order.dispatchDate || ""} (${order.dispatchSlot?.label || "Scheduled"})`;
  page.drawText(slotText, {
    x: fulfillmentX,
    y: infoBoxY - 28,
    size: 9,
    font: fontRegular,
    color: darkGray,
  });

  const addressText = isPickup
    ? "Pickup at: Metropolis Rivera, Shop No 10, Kasarvadavali"
    : `Address: ${order.deliveryAddress?.street || order.deliveryAddress?.borzoFormat?.address || "Delivery Address"}`;

  page.drawText(addressText.slice(0, 52), {
    x: fulfillmentX,
    y: infoBoxY - 40,
    size: 8.5,
    font: fontRegular,
    color: mediumGray,
  });

  y = infoBoxY - 60;

  // 3. Itemized Table
  // Header Row
  page.drawRectangle({
    x: 50,
    y: y - 6,
    width: width - 100,
    height: 22,
    color: lightGray,
  });

  page.drawText("ITEM DESCRIPTION", { x: 60, y: y, size: 9, font: fontBold, color: darkGray });
  page.drawText("QTY", { x: 340, y: y, size: 9, font: fontBold, color: darkGray });
  page.drawText("PRICE", { x: 410, y: y, size: 9, font: fontBold, color: darkGray });
  page.drawText("AMOUNT", { x: 495, y: y, size: 9, font: fontBold, color: darkGray });

  y -= 20;

  for (const item of order.items) {
    page.drawText(item.productName, {
      x: 60,
      y,
      size: 9.5,
      font: fontBold,
      color: darkGray,
    });
    page.drawText(String(item.quantity), {
      x: 345,
      y,
      size: 9.5,
      font: fontRegular,
      color: darkGray,
    });
    page.drawText(`INR ${item.price}`, {
      x: 410,
      y,
      size: 9.5,
      font: fontRegular,
      color: darkGray,
    });
    page.drawText(`INR ${item.subtotal}`, {
      x: 495,
      y,
      size: 9.5,
      font: fontBold,
      color: darkGray,
    });

    y -= 14;

    // Attached Add-ons
    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        page.drawText(`+ ${addon.name} (x${addon.quantity})`, {
          x: 75,
          y,
          size: 8.5,
          font: fontRegular,
          color: mediumGray,
        });
        page.drawText(`INR ${addon.subtotal}`, {
          x: 495,
          y,
          size: 8.5,
          font: fontRegular,
          color: mediumGray,
        });
        y -= 12;
      }
    }

    // Row divider line
    page.drawLine({
      start: { x: 50, y: y + 4 },
      end: { x: width - 50, y: y + 4 },
      thickness: 0.5,
      color: lineGray,
    });
    y -= 6;
  }

  // 4. Totals Summary
  y -= 10;
  const totalsX = width - 220;

  page.drawText("Subtotal:", { x: totalsX, y, size: 9.5, font: fontRegular, color: mediumGray });
  page.drawText(`INR ${order.itemTotal}`, { x: width - 80, y, size: 9.5, font: fontRegular, color: darkGray });

  y -= 14;
  page.drawText("Delivery Charges:", { x: totalsX, y, size: 9.5, font: fontRegular, color: mediumGray });
  page.drawText(order.deliveryFee > 0 ? `INR ${order.deliveryFee}` : "FREE", {
    x: width - 80,
    y,
    size: 9.5,
    font: fontRegular,
    color: darkGray,
  });

  if (order.discount > 0) {
    y -= 14;
    page.drawText("Discount:", { x: totalsX, y, size: 9.5, font: fontRegular, color: mediumGray });
    page.drawText(`-INR ${order.discount}`, { x: width - 80, y, size: 9.5, font: fontRegular, color: darkGray });
  }

  y -= 16;
  page.drawLine({
    start: { x: totalsX - 10, y: y + 10 },
    end: { x: width - 50, y: y + 10 },
    thickness: 1,
    color: lineGray,
  });

  page.drawText("TOTAL PAID:", {
    x: totalsX,
    y,
    size: 11,
    font: fontBold,
    color: brandRed,
  });
  page.drawText(`INR ${order.totalAmount}`, {
    x: width - 80,
    y,
    size: 12,
    font: fontBold,
    color: brandRed,
  });

  // Payment method note
  y -= 16;
  const paymentMode = `Payment: Online Razorpay (${order.payment?.razorpayPaymentId || "Paid"})`;
  page.drawText(paymentMode, {
    x: totalsX,
    y,
    size: 8,
    font: fontRegular,
    color: mediumGray,
  });

  // 5. Bottom Compliance Disclaimer & Thank you
  const footerY = 60;
  page.drawLine({
    start: { x: 50, y: footerY + 25 },
    end: { x: width - 50, y: footerY + 25 },
    thickness: 0.8,
    color: lineGray,
  });

  page.drawText("Thank you for ordering authentic Himalayan delicacies with Nepali Tales!", {
    x: 50,
    y: footerY + 12,
    size: 9,
    font: fontBold,
    color: darkGray,
  });

  const disclaimerText = "* Disclaimer: All dishes are freshly prepared on a 1-day advance pre-order schedule. Dishes contain Monosodium Glutamate (MSG) in balanced culinary proportions for authentic taste.";
  page.drawText(disclaimerText, {
    x: 50,
    y: footerY,
    size: 7.5,
    font: fontRegular,
    color: mediumGray,
  });

  return await pdfDoc.save();
}

/**
 * Helper to encode Uint8Array to base64 string for Resend attachment payload.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}
