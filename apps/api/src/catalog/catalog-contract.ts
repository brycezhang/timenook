import { ApiProperty } from "@nestjs/swagger";
import { RequestMetaDto } from "../health-contract";
export class RecipientTypeDto {
  @ApiProperty({ pattern: "^[a-z][a-z0-9_-]{1,39}$" }) code!: string;
  @ApiProperty({ maxLength: 40 }) label!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
}
export class ManagedRecipientTypeDto extends RecipientTypeDto {
  @ApiProperty({ minimum: 0, maximum: 100000 }) sortOrder!: number;
  @ApiProperty() active!: boolean;
}
class RecipientCatalogDto {
  @ApiProperty({ type: [RecipientTypeDto] }) types!: RecipientTypeDto[];
  @ApiProperty({ enum: [true] }) customLabelAllowed!: true;
  @ApiProperty({ enum: ["one_adult_subject_one_initiator"] }) scope!: string;
}
export class RecipientCatalogResponseDto {
  @ApiProperty({ type: RecipientCatalogDto }) data!: RecipientCatalogDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class ManagedRecipientResponseDto {
  @ApiProperty({ type: ManagedRecipientTypeDto })
  data!: ManagedRecipientTypeDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class ManagedRecipientsResponseDto {
  @ApiProperty({ type: [ManagedRecipientTypeDto] })
  data!: ManagedRecipientTypeDto[];
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
class PackagePriceDto {
  @ApiProperty({ enum: [99900] }) value!: number;
  @ApiProperty({ enum: ["fen"] }) unit!: string;
  @ApiProperty({ enum: ["CNY"] }) currency!: string;
}
class PackageScopeDto {
  @ApiProperty({ enum: [1] }) projects!: number;
  @ApiProperty({ enum: [1] }) adultSubjects!: number;
  @ApiProperty({ enum: [1] }) initiators!: number;
  @ApiProperty({ enum: [1] }) firstCopies!: number;
  @ApiProperty({ enum: [true] }) agreedShippingIncluded!: boolean;
  @ApiProperty({ enum: [true] }) completeExportIncluded!: boolean;
}
class PackageTermDto {
  @ApiProperty() label!: string;
  @ApiProperty() text!: string;
}
export class PackageVersionDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ minimum: 1 }) sequence!: number;
  @ApiProperty({ pattern: "^[a-f0-9]{64}$" }) contentHash!: string;
  @ApiProperty({ enum: ["local_preview"] }) purpose!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: PackagePriceDto }) price!: PackagePriceDto;
  @ApiProperty({ type: PackageScopeDto }) scope!: PackageScopeDto;
  @ApiProperty({ type: [PackageTermDto] }) terms!: PackageTermDto[];
}
class CurrentPackageDto {
  @ApiProperty({ enum: [false] }) purchasable!: false;
  @ApiProperty({ enum: ["PACKAGE_PREPARING", "PREVIEW_ONLY"] }) reason!: string;
  @ApiProperty({ type: PackageVersionDto, nullable: true })
  version!: PackageVersionDto | null;
}
export class CurrentPackageResponseDto {
  @ApiProperty({ type: CurrentPackageDto }) data!: CurrentPackageDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class PackageVersionResponseDto {
  @ApiProperty({ type: PackageVersionDto }) data!: PackageVersionDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class PackageVersionsResponseDto {
  @ApiProperty({ type: [PackageVersionDto] }) data!: PackageVersionDto[];
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
class CatalogIssueDto {
  @ApiProperty() path!: string;
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}
class CatalogValidationDto {
  @ApiProperty({ enum: ["complete", "incomplete"] }) completeness!: string;
  @ApiProperty({ enum: [false] }) salesAuthorized!: false;
  @ApiProperty({ enum: ["not_verified"] }) evidenceAuthenticity!: string;
  @ApiProperty({ enum: ["not_verified"] }) approval!: string;
  @ApiProperty({ enum: [true] }) previewOnly!: boolean;
  @ApiProperty({ type: [CatalogIssueDto] }) issues!: CatalogIssueDto[];
}
class PackageDraftDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty({ type: Object, additionalProperties: true }) d01!: object;
  @ApiProperty({ type: Object, additionalProperties: true }) admission!: object;
  @ApiProperty({ type: Object, additionalProperties: { type: "string" } })
  shippingRegionLabels!: object;
  @ApiProperty({ type: CatalogValidationDto })
  validation!: CatalogValidationDto;
}
export class PackageDraftResponseDto {
  @ApiProperty({ type: PackageDraftDto }) data!: PackageDraftDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class PackageDraftsResponseDto {
  @ApiProperty({ type: [PackageDraftDto] }) data!: PackageDraftDto[];
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
