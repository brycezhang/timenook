import sharp from "sharp";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
const [input, output, widthArg, heightArg] = process.argv.slice(2);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  if (
    process.env.PRINT_PROBE_ENABLED !== "synthetic-local" ||
    process.env.NODE_ENV === "production"
  )
    throw Error("PRINT_PROBE_DISABLED");
  const widthMm = Number(widthArg),
    heightMm = Number(heightArg);
  if (
    ![widthMm, heightMm].every((n) => Number.isFinite(n) && n >= 1 && n <= 300)
  )
    throw Error("INVALID_PLACEMENT");
  if ((await stat(input)).size > 16 * 1024 * 1024)
    throw Error("INPUT_BYTE_LIMIT");
  const bytes = await readFile(input);
  sharp.cache(false);
  sharp.concurrency(1);
  const source = sharp(bytes, {
    limitInputPixels: 16_000_000,
    failOn: "warning",
    animated: false,
  });
  const metadata = await source.metadata();
  let libheifJs;
  let decoded, info;
  if (
    (metadata.pages ?? 1) !== 1 ||
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > 16_000_000
  )
    throw Error("INPUT_PIXEL_LIMIT");
  if (metadata.format === "heif" && metadata.compression === "hevc") {
    if (
      metadata.hasProfile ||
      (metadata.bitsPerSample ?? 8) !== 8 ||
      metadata.depth !== "uchar"
    )
      throw Error("UNVERIFIED_HEIC_COLOR");
    const { default: libheif } = await import("libheif-js/wasm-bundle.js");
    const images = new libheif.HeifDecoder().decode(bytes);
    try {
      if (images.length !== 1) throw Error("UNSUPPORTED_HEIC_SEQUENCE");
      const image = images[0],
        width = image.get_width(),
        height = image.get_height();
      if (width < 1 || height < 1 || width * height > 16_000_000)
        throw Error("INPUT_PIXEL_LIMIT");
      // libheif applies HEIF irot/imir transformations. Do not rotate those twice.
      // Additional EXIF orientation in HEIC is not accepted until independently tested.
      if (metadata.orientation && metadata.orientation !== 1)
        throw Error("UNVERIFIED_HEIC_ORIENTATION");
      const pixels = await new Promise((resolve, reject) =>
        image.display(
          { data: new Uint8ClampedArray(width * height * 4), width, height },
          (value) =>
            value ? resolve(value) : reject(Error("HEIC_DECODE_REJECTED")),
        ),
      );
      decoded = Buffer.from(pixels.data);
      info = { width, height, channels: 4 };
      libheifJs = "1.23.5";
    } finally {
      for (const image of images) image.free();
    }
  } else {
    if (!["jpeg", "png"].includes(metadata.format))
      throw Error("UNSUPPORTED_FORMAT");
    ({ data: decoded, info } = await source
      .autoOrient()
      .toColourspace("srgb")
      .raw()
      .timeout({ seconds: 8 })
      .toBuffer({ resolveWithObject: true }));
  }
  const pixelSource = () =>
    sharp(decoded, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    });
  const preview = await pixelSource()
    .resize({
      width: 1200,
      height: 1200,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  const print = await pixelSource().png().toBuffer();
  const originalHash = sha(bytes);
  await writeFile(join(output, "original.bin"), bytes, {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(join(output, "preview.jpg"), preview, {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(join(output, "print.png"), print, {
    mode: 0o600,
    flag: "wx",
  });
  const effectiveDpi = Math.max(
    info.width / (widthMm / 25.4),
    info.height / (heightMm / 25.4),
  );
  await writeFile(
    join(output, "photo.json"),
    JSON.stringify(
      {
        scope: "synthetic-local-probe",
        format: libheifJs ? "heic" : metadata.format,
        orientedPixels: { width: info.width, height: info.height },
        original: { file: "original.bin", sha256: originalHash },
        preview: {
          file: "preview.jpg",
          sha256: sha(preview),
          sourceSha256: originalHash,
        },
        print: {
          file: "print.png",
          sha256: sha(print),
          sourceSha256: originalHash,
        },
        printPlacement: { widthMm, heightMm, fit: "contain" },
        effectiveDpi: Math.round(effectiveDpi * 100) / 100,
        actualPrintSizeMm: {
          width: Math.round((info.width / effectiveDpi) * 25.4 * 100) / 100,
          height: Math.round((info.height / effectiveDpi) * 25.4 * 100) / 100,
        },
        lowResolution: effectiveDpi < 300,
        candidateDpiThreshold: 300,
        productionThreshold: null,
        decoder: {
          sharp: sharp.versions.sharp,
          vips: sharp.versions.vips,
          ...(libheifJs ? { libheifJs } : {}),
        },
        limits: {
          bytes: 16777216,
          pixels: 16000000,
          timeoutMs: 15000,
          rssWatchdogMiB: 384,
          rssSamplingMs: 50,
          hardOsMemoryLimit: false,
        },
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
} catch (error) {
  console.error(
    /^[A-Z_]+$/.test(error.message) ? error.message : "PHOTO_DECODE_REJECTED",
  );
  process.exitCode = 1;
}
