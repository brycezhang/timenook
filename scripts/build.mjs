import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
const out = "dist/miniprogram";
const release = process.env.TIMENOOK_MINIPROGRAM_PROFILE !== "development";
const apiBase =
  process.env.TIMENOOK_API_BASE_URL ??
  (release ? "https://timenookapi.threeminreading.com/api/v1" : "");
if (release && !/^https:\/\/[^/]+\/api\/v1$/.test(apiBase))
  throw new Error("Release builds require an HTTPS API base");
if (
  release &&
  (process.env.TIMENOOK_AUDIO_PROBE_BUILD === "1" ||
    process.env.TIMENOOK_PAYMENT_VERIFICATION)
)
  throw new Error("Release builds cannot enable probes or payment simulation");
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
const files = (await walk("miniprogram")).filter(
  (file) =>
    !release ||
    !/\/(?:pages\/(?:audio-probe|account-link)\/|services\/(?:audio-probe|account-link)\.ts)/.test(
      file,
    ),
);
const config = JSON.parse(await fs.readFile("miniprogram/app.json", "utf8"));
if (release)
  config.pages = config.pages.filter(
    (page) => !/^pages\/(audio-probe|account-link)\//.test(page),
  );
for (const file of files.filter((f) => !f.endsWith(".ts"))) {
  const dest = file.replace("miniprogram/", out + "/");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (file.endsWith(".wxml") && release) {
    const source = await fs.readFile(file, "utf8");
    await fs.writeFile(
      dest,
      source.replace(
        /<!-- @development:start -->[\s\S]*?<!-- @development:end -->/g,
        "",
      ),
    );
  } else await fs.copyFile(file, dest);
}
await fs.writeFile(`${out}/app.json`, JSON.stringify(config, null, 2) + "\n");
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
        if (release)
          build.onLoad({ filter: /\.ts$/ }, async (args) => ({
            contents: (await fs.readFile(args.path, "utf8")).replace(
              /\s*\/\/ @web-only:start[\s\S]*?\/\/ @web-only:end/g,
              "",
            ),
            loader: "ts",
          }));
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
    __TIMENOOK_NATIVE_RELEASE__: JSON.stringify(release),
    __TIMENOOK_NATIVE_TABS__: "true",
    __TIMENOOK_PAYMENT_VERIFICATION__: JSON.stringify(
      process.env.TIMENOOK_PAYMENT_VERIFICATION === "local-verification",
    ),
    __TIMENOOK_AUDIO_PROBE__: JSON.stringify(
      process.env.TIMENOOK_AUDIO_PROBE_BUILD === "1",
    ),
    __TIMENOOK_API_BASE_URL__: JSON.stringify(apiBase),
  },
});
for (const page of config.pages) {
  for (const ext of [".js", ".wxml", ".wxss", ".json"])
    await fs.access(`${out}/${page}${ext}`);
}
console.log(
  `Built ${config.pages.length} ${release ? "release" : "development"} native mini program pages → ${out}`,
);
