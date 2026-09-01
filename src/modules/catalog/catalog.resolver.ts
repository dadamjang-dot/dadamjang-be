import { Args, Query, Resolver } from "@nestjs/graphql";
import { CatalogService } from "./catalog.service";
import {
  CategoryType,
  CatalogFilterOptionsType,
  ProductConnectionType,
  ProductFilterInput,
  ProductPriceSummaryConnectionType,
  ProductPriceSummaryType,
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

  @Query(() => ProductPriceSummaryType)
  productPriceSummary(@Args("productId") productId: string) {
    return this.catalogService.getProductPriceSummary(productId);
  }

  @Query(() => ProductType)
  product(@Args("productId") productId: string) {
    return this.catalogService.getProduct(productId);
  }
}
