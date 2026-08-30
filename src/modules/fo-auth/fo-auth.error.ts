export class InvalidFoAuthProofError extends Error {
  override readonly name = "InvalidFoAuthProofError";
}

export class ExistingFoIdentityError extends Error {
  override readonly name = "ExistingFoIdentityError";
}
