/** Checks review metadata syntax, not evidence authenticity or sales authority. */
export function isRecordReference(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^record:[A-Za-z0-9][A-Za-z0-9._/-]{2,119}$/.test(value) &&
    !/(?:^record:|[/.])(pending|unknown|tbd|todo|approved|completed|null|undefined)$/i.test(
      value,
    )
  );
}

export function isUtcReviewTime(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value.replace("Z", ".000Z")
  );
}
