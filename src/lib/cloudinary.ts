/**
 * Cloudinary upload utility.
 *
 * Uses Cloudinary's unsigned/signed upload REST API directly
 * (no SDK needed - keeps the Worker bundle small).
 */

interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
}

interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * Upload an image (base64 data URI, File, or Blob) to Cloudinary.
 *
 * @param fileData - Base64 string, File, or Blob of the image
 * @param folder - Cloudinary folder to upload to (e.g., "products")
 * @param config - Cloudinary credentials
 */
export async function uploadToCloudinary(
  fileData: string | File | Blob,
  folder: string,
  config: CloudinaryConfig,
): Promise<CloudinaryUploadResult> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Build the string to sign
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = await generateSHA1Signature(
    paramsToSign + config.apiSecret,
  );

  const formData = new FormData();
  formData.append("file", fileData);
  formData.append("folder", folder);
  formData.append("timestamp", String(timestamp));
  formData.append("api_key", config.apiKey);
  formData.append("signature", signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`,
    {
      method: "POST",
      body: formData,
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cloudinary upload failed: ${error}`);
  }

  return response.json() as Promise<CloudinaryUploadResult>;
}

/**
 * Delete an image from Cloudinary by public_id.
 */
export async function deleteFromCloudinary(
  publicId: string,
  config: CloudinaryConfig,
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);

  const paramsToSign = `public_id=${publicId}&timestamp=${timestamp}`;
  const signature = await generateSHA1Signature(
    paramsToSign + config.apiSecret,
  );

  const formData = new FormData();
  formData.append("public_id", publicId);
  formData.append("timestamp", String(timestamp));
  formData.append("api_key", config.apiKey);
  formData.append("signature", signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${config.cloudName}/image/destroy`,
    {
      method: "POST",
      body: formData,
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cloudinary delete failed: ${error}`);
  }
}

/**
 * SHA-1 signature using Web Crypto API.
 */
async function generateSHA1Signature(data: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgBuffer);
  return Buffer.from(hashBuffer).toString("hex");
}
