import { Args, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { CatalogService } from "./catalog.service";
import {
  CategoryType,
  CreateCategoryInput,
  ProductConnectionType,
  ProductFilterInput,
  ProductPriceEvidenceType,
  ProductPriceSummaryConnectionType,
  ProductType,
} from "./catalog.types";

@Resolver()
export class CatalogResolver {
  constructor(private readonly catalogService: CatalogService) {}

  @Query(() => [CategoryType])
  categories() {
    return this.catalogService.listCategories();
  }

  @Query(() => ProductConnectionType)
  products(@Args("filter", { type: () => ProductFilterInput, nullable: true }) filter?: ProductFilterInput) {
    return this.catalogService.listProducts(filter ?? {});
  }

  @Query(() => ProductPriceSummaryConnectionType)
  productPriceSummaries(
    @Args("filter", { type: () => ProductFilterInput, nullable: true })
    filter?: ProductFilterInput,
  ) {
    return this.catalogService.listProductPriceSummaries(filter ?? {});
  }

  @Query(() => ProductType)
  product(@Args("productId") productId: string) {
    return this.catalogService.getProduct(productId);
  }

  @Query(() => ProductPriceEvidenceType)
  productPriceEvidence(
    @Args("productId") productId: string,
    @Args("priceRevision", { nullable: true }) priceRevision?: string,
  ) {
    return this.catalogService.getProductPriceEvidence(productId, priceRevision);
  }

  @Mutation(() => CategoryType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  createCategory(@Args("input") input: CreateCategoryInput) {
    return this.catalogService.createCategory(input);
  }
}
