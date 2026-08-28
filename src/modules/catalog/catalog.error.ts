export enum CatalogErrorMessage {
  InvalidCursor = "Invalid product cursor",
  ProductNotFound = "Product not found",
  InvalidPriceOrStock = "Price and stock must be non-negative",
  PriceRevisionChanged = "Product price has changed",
  PublishUnapprovedProduct = "Product must be approved before publishing",
}
