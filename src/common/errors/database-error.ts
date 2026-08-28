export const hasDatabaseErrorCode = (error: unknown, code: string, depth = 0): boolean => {
  if (typeof error !== "object" || error === null || depth > 4) return false;
  if ("code" in error && error.code === code) return true;
  return "cause" in error && hasDatabaseErrorCode(error.cause, code, depth + 1);
};
