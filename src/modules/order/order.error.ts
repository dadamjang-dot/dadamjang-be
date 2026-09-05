export enum OrderErrorMessage {
  IdempotencyKeyRequired = "idempotencyKey is required",
  IdempotencyKeyTooLong = "idempotencyKey must not exceed 120 characters",
  ExpectedCartInvalid = "expectedCart is invalid",
  CartSnapshotChanged = "Cart snapshot changed",
  CheckoutAttemptMalformed = "Completed checkout attempt is missing its order",
  CheckoutProcessing = "Checkout already processing",
  CartEmpty = "Cart is empty",
  CartContainsUnavailableItem = "Cart contains an unavailable item",
  OrderNotFound = "Order not found",
  AuthenticationRequired = "Authentication required",
}

export const getInsufficientStockMessage = (code: string) => `Insufficient stock for ${code}`;

export const getCannotTransitionMessage = (status: string, nextStatus: string) =>
  `Cannot transition ${status} to ${nextStatus}`;
