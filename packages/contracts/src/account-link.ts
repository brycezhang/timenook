export interface AccountLinkChallenge {
  id: string;
  targetUser: { id: string };
  expiresAt: string;
  state: "waiting" | "paired" | "linked" | "cancelled" | "expired";
  verificationCode: string | null;
  webConfirmed: boolean;
  nativeConfirmed: boolean;
}
export interface AccountLinkResult {
  challenge: AccountLinkChallenge;
}
export interface AccountLinkClaim extends AccountLinkResult {
  proof: string;
}
export interface AccountLinkCreated extends AccountLinkResult {
  challenge: AccountLinkChallenge & { code: string };
}
export function isAccountLinkResult(
  value: unknown,
): value is AccountLinkResult {
  const row = (value as AccountLinkResult | undefined)?.challenge;
  return (
    !!row &&
    /^[0-9a-f-]{36}$/.test(row.id) &&
    /^[0-9a-f-]{36}$/.test(row.targetUser?.id ?? "") &&
    Number.isFinite(Date.parse(row.expiresAt)) &&
    ["waiting", "paired", "linked", "cancelled", "expired"].includes(
      row.state,
    ) &&
    (row.verificationCode === null || /^\d{6}$/.test(row.verificationCode)) &&
    typeof row.webConfirmed === "boolean" &&
    typeof row.nativeConfirmed === "boolean"
  );
}
