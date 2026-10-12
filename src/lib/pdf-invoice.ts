import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { OrderDoc } from "../types";

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (!current) {
      current = w;
    } else if ((current + " " + w).length <= maxChars) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface ReceiptLine {
  text?: string;
  left?: string;
  right?: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
}

/**
 * Generates an authentic 80mm thermal receipt PDF for a Nepali Tales order.
 * Pure vector pdf-lib, runs seamlessly on Cloudflare Workers.
 */
export async function generateOrderInvoicePdf(order: OrderDoc): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  const font = await pdfDoc.embedFont(StandardFonts.Courier);
  const fontBold = await pdfDoc.embedFont(StandardFonts.CourierBold);

  const COLS = 38;
  const FONT_SIZE = 8.5;
  const LINE_HEIGHT = 11.5;
  const PAGE_WIDTH = 226.77; // 80mm in points
  const MARGIN_LEFT = 14;

  const formattedDate = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(order.createdAt));

  const formattedTime = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(order.createdAt));

  const isPickup = (order.orderType || "delivery") === "pickup";
  const fulfillmentType = isPickup ? "PICKUP" : "DELIVERY";

  const lines: ReceiptLine[] = [];
  const divider: ReceiptLine = { text: "-".repeat(COLS), bold: true };

  // 1. Header
  lines.push({ text: "NEPALI TALES", bold: true, align: "center" });
  const kitchenAddress = "Metropolis Rivera, Shop No 10, Kasarvadavali, Opp to Laxmi Narayan Mandir, 400615";
  for (const l of wrapText(kitchenAddress, COLS)) {
    lines.push({ text: l, align: "center" });
  }
  lines.push({ text: "Ph: 917678097659", align: "center" });
  lines.push(divider);
  lines.push({ text: "RECEIPT", bold: true, align: "center" });
  lines.push(divider);

  // 2. Customer & Order Meta
  lines.push({
    left: `Name: ${(order.customer.name || "Customer").slice(0, 19)}`,
    right: `Inv: ${order.orderNumber}`,
    bold: true,
  });
  lines.push({
    left: `Order #: ${order.orderNumber}`,
    right: formattedDate,
  });
  lines.push({
    left: `TYPE: ${fulfillmentType}`,
    right: `Time: ${formattedTime}`,
    bold: true,
  });

  if (order.dispatchSlot?.label) {
    const slotStr = `Slot: ${order.dispatchDate ? `${order.dispatchDate} ` : ""}${order.dispatchSlot.label}`;
    for (const l of wrapText(slotStr, COLS)) {
      lines.push({ text: l });
    }
  }

  const addrPrefix = isPickup
    ? "Pickup: Metropolis Rivera, Shop 10"
    : `Address: ${order.deliveryAddress?.borzoFormat?.address || order.deliveryAddress?.street || "Thane, Maharashtra"}`;
  for (const l of wrapText(addrPrefix, COLS)) {
    lines.push({ text: l });
  }

  const note = order.deliveryAddress?.borzoFormat?.note || order.deliveryAddress?.landmark;
  if (note) {
    for (const l of wrapText(`Note: ${note}`, COLS)) {
      lines.push({ text: l });
    }
  }

  lines.push(divider);

  // 3. Item Breakdown Table
  lines.push({
    left: "Item",
    right: "Price Qty Total",
    bold: true,
  });

  for (const item of order.items) {
    const priceStr = String(item.price).padStart(5);
    const qtyStr = String(item.quantity).padStart(3);
    const totalStr = String(item.subtotal).padStart(6);
    const colRight = `${priceStr} ${qtyStr} ${totalStr}`;

    const maxItemNameLen = COLS - colRight.length - 1;
    if (item.productName.length <= maxItemNameLen) {
      lines.push({
        left: item.productName,
        right: colRight,
      });
    } else {
      const itemWrapped = wrapText(item.productName, maxItemNameLen);
      lines.push({
        left: itemWrapped[0] ?? item.productName,
        right: colRight,
      });
      for (let i = 1; i < itemWrapped.length; i++) {
        lines.push({ text: `  ${itemWrapped[i]}` });
      }
    }

    if (item.addons && item.addons.length > 0) {
      for (const add of item.addons) {
        const addInfo = `+ ${add.name} (${add.quantity}x @ ${add.price})`;
        const addTotal = String(add.subtotal);
        if (addInfo.length + addTotal.length + 1 <= COLS) {
          lines.push({ left: `  ${addInfo}`, right: addTotal });
        } else {
          lines.push({ text: `  ${addInfo}` });
          lines.push({ right: addTotal });
        }
      }
    }
  }

  lines.push(divider);

  // 4. Totals
  lines.push({
    left: "Sub-Total:",
    right: `INR ${order.itemTotal}`,
  });
  lines.push({
    left: isPickup ? "Fulfillment:" : "Delivery Fee:",
    right: isPickup ? "Free" : order.deliveryFee > 0 ? `INR ${order.deliveryFee}` : "Free",
  });

  if (order.discount > 0) {
    lines.push({
      left: "Discount:",
      right: `-INR ${order.discount}`,
    });
  }

  const paymentMode = order.payment?.provider ? order.payment.provider.toUpperCase() : "ONLINE";
  lines.push({
    left: `Mode: ${paymentMode === "RAZORPAY" ? "Online" : paymentMode}`,
    right: `Total: INR ${order.totalAmount}`,
    bold: true,
  });

  lines.push(divider);

  // 5. Footer
  lines.push({ text: "** SAVE PAPER SAVE NATURE **", bold: true, align: "center" });
  lines.push({ text: `Time: ${formattedTime}`, align: "center" });
  lines.push(divider);

  // Layout calculation
  const totalHeight = lines.length * LINE_HEIGHT + 32;
  const page = pdfDoc.addPage([PAGE_WIDTH, totalHeight]);
  const textColor = rgb(0, 0, 0);

  let y = totalHeight - 18;

  for (const l of lines) {
    const f = l.bold ? fontBold : font;

    if (l.left !== undefined && l.right !== undefined) {
      page.drawText(l.left, {
        x: MARGIN_LEFT,
        y,
        size: FONT_SIZE,
        font: f,
        color: textColor,
      });

      const rightWidth = f.widthOfTextAtSize(l.right, FONT_SIZE);
      page.drawText(l.right, {
        x: PAGE_WIDTH - MARGIN_LEFT - rightWidth,
        y,
        size: FONT_SIZE,
        font: f,
        color: textColor,
      });
    } else if (l.right !== undefined) {
      const rightWidth = f.widthOfTextAtSize(l.right, FONT_SIZE);
      page.drawText(l.right, {
        x: PAGE_WIDTH - MARGIN_LEFT - rightWidth,
        y,
        size: FONT_SIZE,
        font: f,
        color: textColor,
      });
    } else {
      const str = l.text || "";
      let x = MARGIN_LEFT;
      if (l.align === "center") {
        const textWidth = f.widthOfTextAtSize(str, FONT_SIZE);
        x = Math.max(MARGIN_LEFT, (PAGE_WIDTH - textWidth) / 2);
      } else if (l.align === "right") {
        const textWidth = f.widthOfTextAtSize(str, FONT_SIZE);
        x = PAGE_WIDTH - MARGIN_LEFT - textWidth;
      }
      page.drawText(str, {
        x,
        y,
        size: FONT_SIZE,
        font: f,
        color: textColor,
      });
    }

    y -= LINE_HEIGHT;
  }

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
