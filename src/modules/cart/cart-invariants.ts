import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { CartErrorMessage } from "./cart.error";

export const MAX_GRAPHQL_MONEY = 2_147_483_647;
export const MAX_CART_ITEMS = 100;

type CartMoneyLine = {
  readonly price: number;
  readonly quantity: number;
};

const invalidCartTotal = () => new CustomBadRequestException(CartErrorMessage.TotalExceedsSupportedAmount);

export const calculateCartTotal = (lines: readonly CartMoneyLine[]) => {
  let total = 0;
  for (const line of lines) {
    if (line.price > 0 && line.quantity > Math.floor(MAX_GRAPHQL_MONEY / line.price)) throw invalidCartTotal();
    const lineTotal = line.price * line.quantity;
    const nextTotal = total + lineTotal;
    if (
      !Number.isSafeInteger(lineTotal) ||
      !Number.isSafeInteger(nextTotal) ||
      lineTotal > MAX_GRAPHQL_MONEY ||
      nextTotal > MAX_GRAPHQL_MONEY
    )
      throw invalidCartTotal();
    total = nextTotal;
  }
  return total;
};

export const assertCartItemCount = (count: number) => {
  if (count > MAX_CART_ITEMS) throw new CustomBadRequestException(CartErrorMessage.ItemLimitExceeded);
};
