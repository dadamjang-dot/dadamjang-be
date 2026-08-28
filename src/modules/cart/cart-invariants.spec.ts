import { CartErrorMessage } from "./cart.error";
import { assertCartItemCount, calculateCartTotal, MAX_CART_ITEMS, MAX_GRAPHQL_MONEY } from "./cart-invariants";

describe("cart invariants", () => {
  it("accepts line and aggregate totals at the signed INT ceiling", () => {
    expect(calculateCartTotal([{ price: MAX_GRAPHQL_MONEY, quantity: 1 }])).toBe(MAX_GRAPHQL_MONEY);
    expect(
      calculateCartTotal([
        { price: 1_500_000_000, quantity: 1 },
        { price: 647_483_647, quantity: 1 },
      ]),
    ).toBe(MAX_GRAPHQL_MONEY);
  });

  it("rejects line and aggregate totals above the signed INT ceiling", () => {
    expect(() => calculateCartTotal([{ price: MAX_GRAPHQL_MONEY, quantity: 2 }])).toThrow(
      CartErrorMessage.TotalExceedsSupportedAmount,
    );
    expect(() =>
      calculateCartTotal([
        { price: 1_500_000_000, quantity: 1 },
        { price: 647_483_648, quantity: 1 },
      ]),
    ).toThrow(CartErrorMessage.TotalExceedsSupportedAmount);
  });

  it("allows 100 cart items and rejects 101", () => {
    expect(() => assertCartItemCount(MAX_CART_ITEMS)).not.toThrow();
    expect(() => assertCartItemCount(MAX_CART_ITEMS + 1)).toThrow(CartErrorMessage.ItemLimitExceeded);
  });
});
