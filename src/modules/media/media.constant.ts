export const SUPPORTED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const IMAGE_SUMMARY_WIDTH = 640;
export const IMAGE_TRANSFORM_MAX_WIDTH = 2048;
export const STYLE_POST_SUPPORTED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const STYLE_POST_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const UUID_V4_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const FINAL_IMAGE_ID_PATTERN = `(?:${UUID_V4_PATTERN}|[0-9a-f]{64})`;
export const STYLE_POST_IMAGE_KEY_PATTERN = new RegExp(
  `^style-posts/${UUID_V4_PATTERN}/${FINAL_IMAGE_ID_PATTERN}\\.(jpg|png|webp|heic|heif)$`,
);
export const STYLE_POST_PENDING_IMAGE_KEY_PATTERN = new RegExp(
  `^pending/style-posts/${UUID_V4_PATTERN}/${UUID_V4_PATTERN}\\.(jpg|png|webp)$`,
);
export const STYLE_POST_MAX_FILE_SIZE = 10 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_FILE_SIZE = 10 * 1024 * 1024;
export const PRODUCT_IMAGE_KEY_PATTERN = new RegExp(
  `^products/${UUID_V4_PATTERN}/${FINAL_IMAGE_ID_PATTERN}\\.(jpg|png|webp)$`,
);
export const PRODUCT_PENDING_IMAGE_KEY_PATTERN = new RegExp(
  `^pending/products/${UUID_V4_PATTERN}/${UUID_V4_PATTERN}\\.(jpg|png|webp)$`,
);
