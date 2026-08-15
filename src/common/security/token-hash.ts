import { createHash } from "crypto";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
