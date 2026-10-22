import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import sharp from "sharp";

const cli = resolve("scripts/print-probe/cli.mjs");
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, PRINT_PROBE_ENABLED: "synthetic-local", ...env },
  });
}

test("photo CLI preserves original, applies EXIF orientation, strips location metadata and reports actual print resolution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-photo-"));
  try {
    const source = join(dir, "misnamed.heic");
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: "#e54334" },
    })
      .jpeg()
      .withExif({
        IFD0: { Orientation: "6" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "31/1 14/1 0/1" },
      })
      .withMetadata({ orientation: 6 })
      .toFile(source);
    const output = join(dir, "result");
    const result = run(["photo", source, output, "100", "150"]);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(
      await readFile(join(output, "photo.json"), "utf8"),
    );
    assert.equal(manifest.format, "jpeg");
    assert.deepEqual(manifest.orientedPixels, { width: 80, height: 120 });
    assert.equal(
      manifest.original.sha256,
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
    );
    assert.deepEqual(
      await readFile(join(output, manifest.original.file)),
      await readFile(source),
    );
    assert.equal(
      new Set([
        manifest.original.file,
        manifest.preview.file,
        manifest.print.file,
      ]).size,
      3,
    );
    for (const item of [manifest.preview, manifest.print]) {
      const metadata = await sharp(join(output, item.file)).metadata();
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.orientation, undefined);
      assert.equal(metadata.width, 80);
      assert.equal(metadata.height, 120);
      assert.equal(item.sourceSha256, manifest.original.sha256);
    }
    assert.equal(manifest.printPlacement.widthMm, 100);
    assert.equal(manifest.effectiveDpi, 20.32);
    assert.equal(manifest.lowResolution, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("real HEVC HEIC candidate decodes through the pinned WASM chain into independent print pixels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-heic-"));
  try {
    const source = resolve("tests/print-probe/fixtures/synthetic.heic");
    assert.equal((await sharp(source).metadata()).compression, "hevc");
    const result = run(["photo", source, join(dir, "result"), "8", "5"]);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(
      await readFile(join(dir, "result/photo.json"), "utf8"),
    );
    assert.equal(manifest.format, "heic");
    assert.deepEqual(manifest.orientedPixels, { width: 96, height: 64 });
    assert.equal(manifest.decoder.libheifJs, "1.23.5");
    assert.equal(manifest.lowResolution, false);
    const { data } = await sharp(join(dir, "result/print.png"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Independent source RGB 36,123,147; allow the lossy HEVC encoder a small tolerance.
    for (const [i, expected] of [36, 123, 147].entries())
      assert.ok(Math.abs(data[i] - expected) < 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("photo probe fails closed when disabled, in production, for corrupt data or above byte and pixel budgets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-invalid-"));
  try {
    const source = resolve("tests/print-probe/fixtures/synthetic.heic");
    for (const env of [
      { PRINT_PROBE_ENABLED: "" },
      { NODE_ENV: "production" },
    ]) {
      const result = run(
        ["photo", source, join(dir, "result"), "80", "60"],
        env,
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /DISABLED/);
    }
    const { writeFile, readdir } = await import("node:fs/promises");
    await writeFile(
      join(dir, "corrupt.jpg"),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    );
    await writeFile(join(dir, "large.jpg"), Buffer.alloc(16777217));
    await sharp({
      create: { width: 4001, height: 4000, channels: 3, background: "white" },
    })
      .png()
      .toFile(join(dir, "pixels.png"));
    for (const file of ["corrupt.jpg", "large.jpg", "pixels.png"]) {
      const result = run([
        "photo",
        join(dir, file),
        join(dir, "result"),
        "80",
        "60",
      ]);
      assert.equal(result.status, 1, file);
      await assert.rejects(readFile(join(dir, "result/photo.json")));
    }
    assert.ok(!(await readdir(dir)).some((name) => name.includes(".partial-")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all eight EXIF orientations preserve the independently expected corner placement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-orientation-"));
  const colors = [
    [230, 20, 20],
    [20, 230, 20],
    [20, 20, 230],
    [230, 230, 20],
  ];
  const expected = [
    [0, 1, 2, 3],
    [1, 0, 3, 2],
    [3, 2, 1, 0],
    [2, 3, 0, 1],
    [0, 2, 1, 3],
    [2, 0, 3, 1],
    [3, 1, 2, 0],
    [1, 3, 0, 2],
  ];
  try {
    const pixels = Buffer.alloc(120 * 80 * 3);
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 120; x++)
        pixels.set(
          colors[(y >= 40 ? 2 : 0) + (x >= 60 ? 1 : 0)],
          (y * 120 + x) * 3,
        );
    for (let orientation = 1; orientation <= 8; orientation++) {
      const file = join(dir, `${orientation}.jpg`),
        out = join(dir, `out-${orientation}`);
      await sharp(pixels, { raw: { width: 120, height: 80, channels: 3 } })
        .withMetadata({ orientation })
        .jpeg({ quality: 100 })
        .toFile(file);
      assert.equal(run(["photo", file, out, "80", "60"]).status, 0);
      const { data, info } = await sharp(join(out, "print.png"))
        .raw()
        .toBuffer({ resolveWithObject: true });
      const positions = [
        [10, 10],
        [info.width - 11, 10],
        [10, info.height - 11],
        [info.width - 11, info.height - 11],
      ];
      for (let corner = 0; corner < 4; corner++)
        for (let channel = 0; channel < 3; channel++) {
          const [x, y] = positions[corner];
          assert.ok(
            Math.abs(
              data[(y * info.width + x) * info.channels + channel] -
                colors[expected[orientation - 1][corner]][channel],
            ) < 8,
            `orientation ${orientation}, corner ${corner}`,
          );
        }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contain placement computes clarity from the actual printed rectangle rather than its empty letterbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-fit-"));
  try {
    const out = join(dir, "result");
    assert.equal(
      run([
        "photo",
        resolve("tests/print-probe/fixtures/synthetic.heic"),
        out,
        "100",
        "150",
      ]).status,
      0,
    );
    const m = JSON.parse(await readFile(join(out, "photo.json"), "utf8"));
    assert.equal(m.effectiveDpi, 24.38);
    assert.deepEqual(m.actualPrintSizeMm, { width: 100, height: 66.67 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded worker terminates on tighter memory/time budgets and leaves no partial artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-worker-limits-"));
  try {
    for (const env of [
      { PRINT_PROBE_RSS_MIB: "1" },
      { PRINT_PROBE_TIMEOUT_MS: "1" },
    ]) {
      const out = join(dir, "result");
      const r = run(
        [
          "photo",
          resolve("tests/print-probe/fixtures/synthetic.heic"),
          out,
          "80",
          "60",
        ],
        env,
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /RESOURCE_LIMIT/);
      const { readdir } = await import("node:fs/promises");
      assert.deepEqual(await readdir(dir), []);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unavailable RSS monitor refuses work instead of silently dropping its resource boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t04-monitor-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const result = run(
      [
        "photo",
        resolve("tests/print-probe/fixtures/synthetic.heic"),
        join(dir, "result"),
        "80",
        "60",
      ],
      { PATH: dir },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RESOURCE_MONITOR_FAILED/);
    await assert.rejects(readFile(join(dir, "result/photo.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
