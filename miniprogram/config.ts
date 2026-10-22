// Build with TIMENOOK_API_BASE_URL. Empty means real login is unavailable;
// the ADR 0009 public URL is a deployment target, not an already live service.
declare const __TIMENOOK_API_BASE_URL__: string | undefined;
export const API_BASE_URL =
  typeof __TIMENOOK_API_BASE_URL__ === "string"
    ? __TIMENOOK_API_BASE_URL__
    : "";
