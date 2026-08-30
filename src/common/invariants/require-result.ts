export const requireResult = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Required operation result is missing");
  return value;
};
