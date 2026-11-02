const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiIso(value: string | Date | null | undefined): string | null {
  if (value == null || value === "") return null;
  const instant = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  const shifted = new Date(instant + SHANGHAI_OFFSET_MS);
  return Number.isFinite(shifted.getTime()) ? shifted.toISOString() : null;
}

/** Admin timestamps use Beijing time (Asia/Shanghai, UTC+8), independent of the device. */
export function formatAdminTime(
  value: string | Date | null | undefined,
): string {
  return shanghaiIso(value)?.slice(0, 19).replace("T", " ") ?? "—";
}

/** A datetime-local field represents UTC+8 wall time; keep milliseconds on edits. */
export function formatAdminTimeInput(
  value: string | Date | null | undefined,
): string {
  return (
    shanghaiIso(value)
      ?.slice(0, 23)
      .replace(/\.0+$/, "")
      .replace(/(\.\d*?[1-9])0+$/, "$1") ?? ""
  );
}

/** Parse the field's UTC+8 wall time into an instant, never the device time zone. */
export function parseAdminTimeInput(value: string): number {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      value,
    );
  if (!match) return NaN;
  const canonical = `${match[1]}:${match[2] ?? "00"}.${(match[3] ?? "").padEnd(3, "0")}`;
  const instant = Date.parse(`${canonical}+08:00`);
  // Date.parse normalizes some impossible dates; reject these instead of changing them.
  return shanghaiIso(new Date(instant))?.slice(0, 23) === canonical
    ? instant
    : NaN;
}
