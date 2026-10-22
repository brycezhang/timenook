import { ApiProperty } from "@nestjs/swagger";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import type {
  AdminAuditEntry,
  AdminEnrollment,
  AdminOperator,
  AdminRuntime,
  AdminState,
  ApiResponse,
} from "@timenook/contracts";
import { RequestMetaDto } from "../health-contract";
export class AdminOperatorDto implements AdminOperator {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ type: [String], enum: Object.values(ADMIN_PERMISSIONS) })
  permissions!: AdminOperator["permissions"];
}
export class AdminStateDto implements AdminState {
  @ApiProperty() authenticated!: boolean;
  @ApiProperty() mfaRequired!: boolean;
  @ApiProperty() enrollmentRequired!: boolean;
  @ApiProperty({ type: () => AdminOperatorDto, nullable: true })
  operator!: AdminOperatorDto | null;
  @ApiProperty({ description: "Session-bound CSRF token, keep in memory only" })
  csrfToken!: string;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
}
export class AdminStateResponseDto implements ApiResponse<AdminState> {
  @ApiProperty({ type: AdminStateDto }) data!: AdminStateDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AdminEnrollmentDto implements AdminEnrollment {
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
export class AdminEnrollmentResponseDto implements ApiResponse<AdminEnrollment> {
  @ApiProperty({ type: AdminEnrollmentDto }) data!: AdminEnrollmentDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AdminRuntimeDto implements AdminRuntime {
  @ApiProperty({ enum: ["timenook-api"] }) service!: AdminRuntime["service"];
  @ApiProperty({ enum: ["ready", "unavailable"] })
  status!: AdminRuntime["status"];
}
export class AdminRuntimeResponseDto implements ApiResponse<AdminRuntime> {
  @ApiProperty({ type: AdminRuntimeDto }) data!: AdminRuntimeDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AdminAuditDto implements AdminAuditEntry {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ type: String, nullable: true, format: "uuid" }) operatorId!:
    string | null;
  @ApiProperty() action!: string;
  @ApiProperty({ format: "uuid" }) requestId!: string;
  @ApiProperty() result!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}
export class AdminAuditResponseDto implements ApiResponse<AdminAuditEntry[]> {
  @ApiProperty({ type: [AdminAuditDto] }) data!: AdminAuditDto[];
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
