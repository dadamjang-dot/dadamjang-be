import { Args, Query, Resolver } from "@nestjs/graphql";
import { CatalogService } from "./catalog.service";
import {
  CategoryType,
  CatalogFilterOptionsType,
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

  @Query(() => CatalogFilterOptionsType)
  catalogFilterOptions() {
    return this.catalogService.listCatalogFilterOptions();
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
}
