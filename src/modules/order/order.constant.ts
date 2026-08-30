export const ORDER_STATUSES = ["PAYMENT_PENDING", "PAID", "FULFILLING", "COMPLETED", "FAILED", "CANCELLED"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ["PENDING", "APPROVED", "FAILED", "CANCELLED"] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

type OrderTransitionRule = {
  requiredPaymentStatus: PaymentStatus;
  paymentStatus: PaymentStatus;
  paymentFailureReason: string | null;
};

export const ORDER_TRANSITION_RULES = {
  PAYMENT_PENDING: {
    FAILED: {
      requiredPaymentStatus: "PENDING",
      paymentStatus: "FAILED",
      paymentFailureReason: "Payment marked failed by an administrator",
    },
    CANCELLED: {
      requiredPaymentStatus: "PENDING",
      paymentStatus: "CANCELLED",
      paymentFailureReason: null,
    },
  },
  PAID: {
    FULFILLING: {
      requiredPaymentStatus: "APPROVED",
      paymentStatus: "APPROVED",
      paymentFailureReason: null,
    },
    CANCELLED: {
      requiredPaymentStatus: "APPROVED",
      paymentStatus: "APPROVED",
      paymentFailureReason: null,
    },
  },
  FULFILLING: {
    COMPLETED: {
      requiredPaymentStatus: "APPROVED",
      paymentStatus: "APPROVED",
      paymentFailureReason: null,
    },
    CANCELLED: {
      requiredPaymentStatus: "APPROVED",
      paymentStatus: "APPROVED",
      paymentFailureReason: null,
    },
  },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {},
} as const satisfies Record<OrderStatus, Partial<Record<OrderStatus, OrderTransitionRule>>>;

export const isOrderStatus = (value: string): value is OrderStatus => ORDER_STATUSES.some((status) => status === value);

export const isPaymentStatus = (value: string): value is PaymentStatus =>
  PAYMENT_STATUSES.some((status) => status === value);

export const getOrderTransitionRule = (
  currentStatus: OrderStatus,
  nextStatus: OrderStatus,
): OrderTransitionRule | undefined =>
  (ORDER_TRANSITION_RULES[currentStatus] as Partial<Record<OrderStatus, OrderTransitionRule>>)[nextStatus];

export const getAllowedOrderTransitions = (status: string): OrderStatus[] => {
  if (!isOrderStatus(status)) return [];
  return ORDER_STATUSES.filter((nextStatus) => getOrderTransitionRule(status, nextStatus));
};
