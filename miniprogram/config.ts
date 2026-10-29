// Build with TIMENOOK_API_BASE_URL. Empty means real login is unavailable;
// the ADR 0009 public URL is a deployment target, not an already live service.
declare const __TIMENOOK_API_BASE_URL__: string | undefined;
declare const __TIMENOOK_COOKIE_WEB__: boolean | undefined;
export const API_BASE_URL =
  typeof __TIMENOOK_COOKIE_WEB__ === "boolean" && __TIMENOOK_COOKIE_WEB__
    ? `${globalThis.location.origin}/api/v1`
    : typeof __TIMENOOK_API_BASE_URL__ === "string"
      ? __TIMENOOK_API_BASE_URL__
      : "";

declare const __TIMENOOK_AUDIO_PROBE__: boolean | undefined;
export const AUDIO_PROBE_BUILD =
  typeof __TIMENOOK_AUDIO_PROBE__ === "boolean" && __TIMENOOK_AUDIO_PROBE__;

// Explicit loopback-only build gate; never enables commercial purchases.
declare const __TIMENOOK_PAYMENT_VERIFICATION__: boolean | undefined;
export const PAYMENT_VERIFICATION_BUILD =
  typeof __TIMENOOK_PAYMENT_VERIFICATION__ === "boolean" &&
  __TIMENOOK_PAYMENT_VERIFICATION__ &&
  /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/api)?\/v1$/.test(API_BASE_URL);
