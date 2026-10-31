import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
const out = "dist/miniprogram";
if (
  process.env.NODE_ENV === "production" &&
  process.env.TIMENOOK_AUDIO_PROBE_BUILD === "1"
)
  throw new Error("Probe cannot be built for production");
await fs.rm(out, { recursive: true, force: true });
async function walk(dir) {
  let files = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(f)));
    else files.push(f);
  }
  return files;
}
const files = await walk("miniprogram");
for (const file of files.filter((f) => !f.endsWith(".ts"))) {
  const dest = file.replace("miniprogram/", out + "/");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(file, dest);
}
await build({
  entryPoints: files.filter((f) => f.endsWith(".ts")),
  outdir: out,
  outbase: "miniprogram",
  format: "cjs",
  target: "es2020",
  platform: "neutral",
  bundle: true,
  plugins: [
    {
      name: "native-shared-modules",
      setup(build) {
        const nativeRoot = path.resolve("miniprogram") + path.sep;
        build.onResolve({ filter: /^\./ }, (args) => {
          // Keep native services as shared CommonJS modules (session, recorder,
          // etc.). Bundle dependencies outside miniprogramRoot into their
          // consumers, since WeChat only uploads files inside that directory.
          if (
            args.kind !== "entry-point" &&
            path.resolve(args.resolveDir, args.path).startsWith(nativeRoot)
          )
            return { path: args.path, external: true };
        });
      },
    },
  ],
  define: {
    __TIMENOOK_NATIVE_TABS__: "true",
    __TIMENOOK_PAYMENT_VERIFICATION__: JSON.stringify(
      process.env.TIMENOOK_PAYMENT_VERIFICATION === "local-verification",
    ),
    __TIMENOOK_AUDIO_PROBE__: JSON.stringify(
      process.env.TIMENOOK_AUDIO_PROBE_BUILD === "1",
    ),
    __TIMENOOK_API_BASE_URL__: JSON.stringify(
      process.env.TIMENOOK_API_BASE_URL ?? "",
    ),
  },
});
for (const page of JSON.parse(await fs.readFile("miniprogram/app.json", "utf8"))
  .pages) {
  for (const ext of [".js", ".wxml", ".wxss", ".json"])
    await fs.access(`${out}/${page}${ext}`);
}
console.log(
  `Built ${JSON.parse(await fs.readFile("miniprogram/app.json", "utf8")).pages.length} native mini program pages → ${out}`,
);
