import { Hono } from "hono";
import type { AppBindings } from "../../config/app";
import { authMiddleware } from "../../middleware/auth";
import { uploadToCloudinary } from "../../lib/cloudinary";

const uploadRoutes = new Hono<AppBindings>();

// All upload routes require authentication
uploadRoutes.use("*", authMiddleware);

/**
 * POST /upload
 *
 * Uploads an image file or base64 data to Cloudinary in the "products" folder.
 * Supports:
 * - multipart/form-data: field "file"
 * - application/json: field "image" (base64 data URI)
 */
uploadRoutes.post("/", async (c) => {
  try {
    const cloudName = c.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = c.env.CLOUDINARY_API_KEY;
    const apiSecret = c.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      return c.json(
        {
          success: false,
          message: "Cloudinary credentials are not configured on the server",
        },
        500,
      );
    }

    const config = { cloudName, apiKey, apiSecret };
    const contentType = c.req.header("content-type") || "";

    // 1. Multipart form upload
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];

      if (!file || typeof file === "string") {
        return c.json(
          { success: false, message: "No image file provided in 'file' field" },
          400,
        );
      }

      // Validate file type
      if (!file.type.startsWith("image/")) {
        return c.json(
          {
            success: false,
            message: "Invalid file type. Only image files (PNG, JPG, JPEG, WebP) are allowed",
          },
          400,
        );
      }

      // 10MB limit
      if (file.size > 10 * 1024 * 1024) {
        return c.json(
          { success: false, message: "Image file exceeds 10MB maximum size limit" },
          400,
        );
      }

      const folderRaw = typeof body["folder"] === "string" ? body["folder"] : c.req.query("folder");
      const folder = folderRaw === "addons" ? "addons" : "products";
      const result = await uploadToCloudinary(file, folder, config);

      return c.json({
        success: true,
        message: "Image uploaded to Cloudinary successfully",
        url: result.secure_url,
        publicId: result.public_id,
      });
    }

    // 2. JSON base64 upload
    const jsonBody = await c.req.json().catch(() => null);
    if (!jsonBody || !jsonBody.image || typeof jsonBody.image !== "string") {
      return c.json(
        {
          success: false,
          message: "Please provide an image file (multipart/form-data) or a base64 image string",
        },
        400,
      );
    }

    const imageStr = jsonBody.image.trim();
    const MAX_BASE64_LENGTH = 14 * 1024 * 1024; // ~10MB decoded binary
    const DATA_URI_IMAGE_REGEX = /^data:image\/(png|jpeg|jpg|webp);base64,/i;

    if (!DATA_URI_IMAGE_REGEX.test(imageStr)) {
      return c.json(
        {
          success: false,
          message:
            "Invalid image format. Base64 uploads must be a data URI formatted as PNG, JPEG, or WebP (e.g., data:image/png;base64,...)",
        },
        400,
      );
    }

    if (imageStr.length > MAX_BASE64_LENGTH) {
      return c.json(
        {
          success: false,
          message: "Base64 image exceeds 10MB maximum size limit",
        },
        400,
      );
    }

    const jsonFolder = jsonBody.folder === "addons" ? "addons" : "products";
    const result = await uploadToCloudinary(imageStr, jsonFolder, config);

    return c.json({
      success: true,
      message: "Image uploaded to Cloudinary successfully",
      url: result.secure_url,
      publicId: result.public_id,
    });
  } catch (error) {
    console.error("Upload to Cloudinary error:", error);
    const msg = error instanceof Error ? error.message : "Failed to upload image to Cloudinary";
    return c.json({ success: false, message: msg }, 500);
  }
});

export { uploadRoutes };
