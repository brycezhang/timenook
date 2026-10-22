import { ApiProperty } from "@nestjs/swagger";
import type { Account, ApiResponse, LoginResult } from "@timenook/contracts";
import { RequestMetaDto } from "../health-contract";

export class AccountDto implements Account {
  @ApiProperty({ format: "uuid" }) id!: string;
}
class SessionDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({
    description:
      "Opaque bearer token. Returned only at issuance; server stores SHA-256 digest.",
    minLength: 43,
    maxLength: 43,
  })
  token!: string;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
}
class LoginDto implements LoginResult {
  @ApiProperty({ type: AccountDto }) user!: AccountDto;
  @ApiProperty({ type: SessionDto }) session!: SessionDto;
}
export class LoginResponseDto implements ApiResponse<LoginResult> {
  @ApiProperty({ type: LoginDto }) data!: LoginDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AccountResponseDto implements ApiResponse<Account> {
  @ApiProperty({ type: AccountDto }) data!: AccountDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
