import { ApiProperty } from "@nestjs/swagger";
import { RequestMetaDto } from "../health-contract";
export class AdminOperatorDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ type: [String], enum: ["ops:read", "audit:read"] })
  permissions!: string[];
}
export class AdminStateDto {
  @ApiProperty() authenticated!: boolean;
  @ApiProperty() mfaRequired!: boolean;
  @ApiProperty() enrollmentRequired!: boolean;
  @ApiProperty({ type: () => AdminOperatorDto, nullable: true })
  operator!: AdminOperatorDto | null;
  @ApiProperty({ description: "Session-bound CSRF token, keep in memory only" })
  csrfToken!: string;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
}
export class AdminStateResponseDto {
  @ApiProperty({ type: AdminStateDto }) data!: AdminStateDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AdminEnrollmentDto {
  @ApiProperty({
    description:
      "Sensitive first-enrollment Base32 seed; never log or store in browser storage",
  })
  secret!: string;
  @ApiProperty({
    description: "Sensitive otpauth URI for the operator authenticator",
  })
  uri!: string;
}
export class AdminEnrollmentResponseDto {
  @ApiProperty({ type: AdminEnrollmentDto }) data!: AdminEnrollmentDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AdminRuntimeDto {
  @ApiProperty({ enum: ["timenook-api"] }) service!: string;
  @ApiProperty({ enum: ["ready", "unavailable"] }) status!: string;
}
export class AdminRuntimeResponseDto {
  @ApiProperty({ type: AdminRuntimeDto }) data!: AdminRuntimeDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AdminAuditDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ type: String, nullable: true, format: "uuid" }) operatorId!:
    string | null;
  @ApiProperty() action!: string;
  @ApiProperty({ format: "uuid" }) requestId!: string;
  @ApiProperty() result!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}
export class AdminAuditResponseDto {
  @ApiProperty({ type: [AdminAuditDto] }) data!: AdminAuditDto[];
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
