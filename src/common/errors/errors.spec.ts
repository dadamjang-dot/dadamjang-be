import { AdminErrorMessage } from "src/modules/admin/admin.error";
import { CartErrorMessage, getInsufficientStockMessage } from "src/modules/cart/cart.error";
import { CatalogErrorMessage } from "src/modules/catalog/catalog.error";
import { ComparisonErrorMessage } from "src/modules/comparison/comparison.error";
import { EventErrorMessage } from "src/modules/event/event.error";
import { FeedErrorMessage } from "src/modules/feed/feed.error";
import { MediaErrorMessage } from "src/modules/media/media.error";
import {
  OrderErrorMessage,
  getInsufficientStockMessage as getOrderInsufficientStockMessage,
  getCannotTransitionMessage,
} from "src/modules/order/order.error";
import { PartnerErrorMessage } from "src/modules/partner/partner.error";
import { StylePostErrorMessage } from "src/modules/style-posts/style-posts.error";
import { WishlistErrorMessage } from "src/modules/wishlist/wishlist.error";

describe("Module Error Messages", () => {
  it("defines admin error messages correctly", () => {
    expect(AdminErrorMessage.PartnerNotFound).toBe("Partner not found");
    expect(AdminErrorMessage.InvalidOrExpiredInvite).toBe("Invalid or expired admin invite");
    expect(AdminErrorMessage.AuthenticationRequired).toBe("Authentication required");
  });

  it("defines cart error messages correctly", () => {
    expect(CartErrorMessage.QuantityMustBePositive).toBe("Quantity must be positive");
    expect(CartErrorMessage.SkuNotFound).toBe("SKU not found");
    expect(CartErrorMessage.ProductUnavailable).toBe("Product is unavailable");
    expect(CartErrorMessage.CartCreationFailed).toBe("Cart creation failed");
    expect(getInsufficientStockMessage("CODE123")).toBe("Insufficient stock for CODE123");
  });

  it("defines catalog error messages correctly", () => {
    expect(CatalogErrorMessage.InvalidCursor).toBe("Invalid product cursor");
    expect(CatalogErrorMessage.ProductNotFound).toBe("Product not found");
    expect(CatalogErrorMessage.InvalidPriceOrStock).toBe("Price and stock must be non-negative");
    expect(CatalogErrorMessage.PublishUnapprovedProduct).toBe("Product must be approved before publishing");
  });

  it("defines comparison error messages correctly", () => {
    expect(ComparisonErrorMessage.ProductNotFound).toBe("Product not found");
    expect(ComparisonErrorMessage.AuthenticationRequired).toBe("Authentication required");
  });

  it("defines event error messages correctly", () => {
    expect(EventErrorMessage.AuthenticationRequired).toBe("Authentication required");
  });

  it("defines feed error messages correctly", () => {
    expect(FeedErrorMessage.InvalidCursor).toBe("Invalid feed cursor");
    expect(FeedErrorMessage.AuthenticationRequired).toBe("Authentication required");
  });

  it("defines media error messages correctly", () => {
    expect(MediaErrorMessage.UnsupportedType).toBe("지원하지 않는 이미지 형식입니다.");
    expect(MediaErrorMessage.InvalidKey).toBe("유효하지 않은 이미지 키입니다.");
  });

  it("defines order error messages correctly", () => {
    expect(OrderErrorMessage.IdempotencyKeyRequired).toBe("idempotencyKey is required");
    expect(OrderErrorMessage.CheckoutProcessing).toBe("Checkout already processing");
    expect(OrderErrorMessage.CartEmpty).toBe("Cart is empty");
    expect(OrderErrorMessage.CartContainsUnavailableItem).toBe("Cart contains an unavailable item");
    expect(OrderErrorMessage.OrderNotFound).toBe("Order not found");
    expect(OrderErrorMessage.AuthenticationRequired).toBe("Authentication required");
    expect(getOrderInsufficientStockMessage("CODE456")).toBe("Insufficient stock for CODE456");
    expect(getCannotTransitionMessage("PAID", "FAILED")).toBe("Cannot transition PAID to FAILED");
  });

  it("defines partner error messages correctly", () => {
    expect(PartnerErrorMessage.AlreadyExists).toBe("Partner application already exists");
    expect(PartnerErrorMessage.NotFound).toBe("Partner application not found");
    expect(PartnerErrorMessage.ApprovalRequiredForProduct).toBe("Partner approval is required before product creation");
    expect(PartnerErrorMessage.ApprovalRequiredForPublishing).toBe("Partner approval is required before publishing");
    expect(PartnerErrorMessage.AuthenticationRequired).toBe("Authentication required");
  });

  it("defines style post error messages correctly", () => {
    expect(StylePostErrorMessage.InvalidCursor).toBe("Invalid style post cursor");
    expect(StylePostErrorMessage.NotFound).toBe("Style post not found");
    expect(StylePostErrorMessage.AuthenticationRequired).toBe("Authentication required");
  });

  it("defines wishlist error messages correctly", () => {
    expect(WishlistErrorMessage.ProductNotFound).toBe("Product not found");
    expect(WishlistErrorMessage.AuthenticationRequired).toBe("Authentication required");
  });
});
