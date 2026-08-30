export enum CartErrorMessage {
  QuantityMustBePositive = "Quantity must be positive",
  SkuNotFound = "SKU not found",
  ProductUnavailable = "Product is unavailable",
  CartCreationFailed = "Cart creation failed",
  TotalExceedsSupportedAmount = "Cart total exceeds supported amount",
  ItemLimitExceeded = "Cart cannot contain more than 100 items",
}

export const getInsufficientStockMessage = (code: string) => `Insufficient stock for ${code}`;
