/** Fixed object kinds shared by product and probe adapters. No caller paths. */
export function objectFormat(key: string) {
  if (/^(staging|sealed)\/[0-9a-f-]{36}\.mp3$/.test(key))
    return {
      limit: 2097152,
      mime: "audio/mpeg",
      staging: key.startsWith("staging/"),
    };
  if (/^photos\/staging\/[0-9a-f-]{36}\.(bin|jpg|png)$/.test(key))
    return {
      limit: key.endsWith(".png") ? 67108864 : 16777216,
      mime: key.endsWith(".jpg")
        ? "image/jpeg"
        : key.endsWith(".png")
          ? "image/png"
          : "application/octet-stream",
      staging: true,
    };
  if (
    /^photos\/sealed\/[0-9a-f-]{36}\/(original\.bin|preview\.jpg|print\.png)$/.test(
      key,
    )
  )
    return {
      limit: key.endsWith(".png") ? 67108864 : 16777216,
      mime: key.endsWith(".jpg")
        ? "image/jpeg"
        : key.endsWith(".png")
          ? "image/png"
          : "application/octet-stream",
      staging: false,
    };
  throw new Error("Invalid object key");
}
