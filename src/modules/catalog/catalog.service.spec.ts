import { decodeProductCursor, encodeProductCursor } from "./catalog.service";

describe("catalog cursor", () => {
  it("round-trips a stable product cursor", () => {
    const cursor = { createdAt: "2026-07-11T00:00:00.000Z", productId: "product-1" };
    expect(decodeProductCursor(encodeProductCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeProductCursor("not-a-cursor")).toThrow("Invalid product cursor");
  });
});
