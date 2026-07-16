import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { CatalogService } from "src/modules/catalog/catalog.service";
import { CreateProductDraftInput } from "src/modules/catalog/catalog.types";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { EmailService } from "src/modules/email/email.service";
import { activityEvents, partners } from "src/modules/database/schema";
import { PartnerErrorMessage } from "./partner.error";
import { ApplyPartnerInput } from "./partner.types";

@Injectable()
export class PartnerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalogService: CatalogService,
    private readonly emailService: EmailService,
  ) {}

  apply = async (ownerUserId: string, input: ApplyPartnerInput) => {
    const [existing] = await this.db.select().from(partners).where(eq(partners.ownerUserId, ownerUserId)).limit(1);
    if (existing) throw new CustomBadRequestException(PartnerErrorMessage.AlreadyExists);
    const businessEmail = this.emailService.normalizeEmail(input.businessEmail);
    await this.emailService.consumeVerifiedEmailToken(input.businessEmailVerificationToken, businessEmail);
    const [partner] = await this.db
      .insert(partners)
      .values({
        ownerUserId,
        businessEmail,
        businessRegistrationNumber: input.businessRegistrationNumber,
        tradeName: input.tradeName,
      })
      .returning();
    await this.db.insert(activityEvents).values({
      actorUserId: ownerUserId,
      eventType: "PARTNER_APPLICATION_SUBMITTED",
      subjectType: "PARTNER",
      subjectId: partner.partnerId,
    });
    return partner;
  };

  getMine = async (ownerUserId: string) => {
    const [partner] = await this.db.select().from(partners).where(eq(partners.ownerUserId, ownerUserId)).limit(1);
    if (!partner) throw new CustomNotFoundException(PartnerErrorMessage.NotFound);
    return partner;
  };

  createDraft = async (ownerUserId: string, input: CreateProductDraftInput) => {
    const partner = await this.getMine(ownerUserId);
    if (partner.status !== "APPROVED")
      throw new CustomBadRequestException(PartnerErrorMessage.ApprovalRequiredForProduct);
    return this.catalogService.createDraft(partner.partnerId, input);
  };

  publishProduct = async (ownerUserId: string, productId: string) => {
    const partner = await this.getMine(ownerUserId);
    if (partner.status !== "APPROVED")
      throw new CustomBadRequestException(PartnerErrorMessage.ApprovalRequiredForPublishing);
    return this.catalogService.publishProduct(partner.partnerId, productId);
  };
}
