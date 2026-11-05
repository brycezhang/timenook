import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAdminTime,
  formatAdminTimeInput,
  parseAdminTimeInput,
} from "../apps/admin/src/utils/time";

test("admin time stays in UTC+8 across midnight and host time zones", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Shanghai"]) {
      process.env.TZ = zone;
      assert.equal(
        formatAdminTime("2026-11-02T16:05:09.590Z"),
        "2026-11-03 00:05:09",
      );
      assert.equal(
        formatAdminTime(new Date("2026-12-31T16:00:00Z")),
        "2027-01-01 00:00:00",
      );
      assert.equal(
        formatAdminTime("2026-11-03T00:05:09+08:00"),
        "2026-11-03 00:05:09",
      );
      const input = formatAdminTimeInput("2026-11-02T16:05:09.590Z");
      assert.equal(input, "2026-11-03T00:05:09.59");
      assert.equal(
        new Date(parseAdminTimeInput(input)).toISOString(),
        "2026-11-02T16:05:09.590Z",
      );
      assert.equal(
        new Date(parseAdminTimeInput("2026-11-03T00:05")).toISOString(),
        "2026-11-02T16:05:00.000Z",
      );
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("missing and invalid admin timestamps render a dash", () => {
  for (const value of [undefined, null, "", "invalid", new Date(NaN)]) {
    assert.equal(formatAdminTime(value), "—");
    assert.equal(formatAdminTimeInput(value), "");
  }
});

test("UTC+8 fields reject impossible dates and keep valid leap days", () => {
  for (const value of [
    "",
    "2026-02-30T10:00",
    "2026-11-03T24:00",
    "2026-11-03T00:05Z",
    "2026-11-03T00:05:09.1234",
  ]) {
    assert.equal(Number.isNaN(parseAdminTimeInput(value)), true);
  }
  assert.equal(
    new Date(parseAdminTimeInput("2028-02-29T00:00:00.001")).toISOString(),
    "2028-02-28T16:00:00.001Z",
  );
});
