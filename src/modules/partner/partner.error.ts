export enum PartnerErrorMessage {
  AlreadyExists = "Partner application already exists",
  NotFound = "Partner application not found",
  ApprovalRequiredForProduct = "Partner approval is required before product creation",
  ApprovalRequiredForPublishing = "Partner approval is required before publishing",
  AuthenticationRequired = "Authentication required",
  InvalidProductInput = "Invalid partner product input",
  InvalidTransition = "Product cannot transition from its current state",
  ConcurrentModification = "Product was modified concurrently",
  ImageOwnership = "Product image key is not owned by the partner",
  CatalogOptionInactive = "Catalog option is inactive or missing",
}
