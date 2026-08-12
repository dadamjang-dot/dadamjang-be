export const SUPPORTED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const STYLE_POST_SUPPORTED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
export const STYLE_POST_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
export const STYLE_POST_IMAGE_KEY_PATTERN =
  /^style-posts\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif)$/;
export const STYLE_POST_MAX_FILE_SIZE = 10 * 1024 * 1024;
