export enum CartErrorMessage {
  QuantityMustBePositive = "Quantity must be positive",
  SkuNotFound = "SKU not found",
  ProductUnavailable = "Product is unavailable",
  CartCreationFailed = "Cart creation failed",
}

export const getInsufficientStockMessage = (code: string) => `Insufficient stock for ${code}`;
