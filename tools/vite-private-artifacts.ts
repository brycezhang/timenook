/** Preserve Vite's default denials and keep local probe data off development HTTP. */
export const privateArtifactsDeny = [
  ".env",
  ".env.*",
  "*.{crt,pem}",
  "**/.git/**",
  "**/.probe-local/**",
  "**/output/pdf/**",
  "**/.cache/print-probe/**",
];
