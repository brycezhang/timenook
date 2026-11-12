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
    // Website originals and development-only book covers are not used by release pages.
    (!/\/assets\/(?:family|book|father-book|home-family|sample-book)\.jpg$/.test(
      file,
    ) &&
      !/\/(?:pages\/(?:audio-probe|account-link|login|assisted|settings|service|refunds|quality|export|deletion-status|project)\/|services\/(?:audio-probe|account-link|login|assisted|settings|service|refunds|quality|export|deletion-status|project)\.ts)/.test(
        file,
      )),
);
const config = JSON.parse(await fs.readFile("miniprogram/app.json", "utf8"));
if (release)
  config.pages = config.pages.filter(
    (page) =>
      !/^pages\/(audio-probe|account-link|login|assisted|settings|service|refunds|quality|export|deletion-status|project)\//.test(
        page,
      ),
  );
for (const file of files.filter(
  (f) => !f.endsWith(".ts") && f !== "miniprogram/app.json",
)) {
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
  nodePaths: [path.resolve(import.meta.dirname, "../node_modules")],
  plugins: [
    {
      name: "native-shared-modules",
      setup(build) {
        if (release)
          build.onLoad({ filter: /\.ts$/ }, async (args) => ({
            contents: (await fs.readFile(args.path, "utf8")).replace(
              /\s*\/\/ @(web|development)-only:start[\s\S]*?\/\/ @\1-only:end/g,
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
if (release) {
  // Only registered pages, their components and their runtime dependencies ship.
  // Shared modules stay separate to preserve native session/recorder singletons.
  const reachable = new Set();
  async function include(file) {
    file = path.normalize(file);
    if (reachable.has(file)) return;
    if (file.startsWith("..") || path.isAbsolute(file))
      throw new Error(`Native dependency escapes miniprogramRoot: ${file}`);
    reachable.add(file);
    const source = await fs.readFile(path.join(out, file), "utf8");
    if (file.endsWith(".js")) {
      for (const [, dependency] of source.matchAll(
        /\brequire\(["']([^"']+)["']\)/g,
      )) {
        if (!dependency.startsWith("."))
          throw new Error(`Native dependency must be relative: ${dependency}`);
        const target = path.join(path.dirname(file), dependency);
        await include(target.endsWith(".js") ? target : target + ".js");
      }
    } else if (file.endsWith(".json")) {
      for (const component of Object.values(
        JSON.parse(source).usingComponents ?? {},
      )) {
        const target = component.startsWith("/")
          ? component.slice(1)
          : path.join(path.dirname(file), component);
        await includePage(target);
      }
    } else if (file.endsWith(".wxml")) {
      for (const [, dependency] of source.matchAll(
        /<(?:import|include)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g,
      ))
        await include(
          dependency.startsWith("/")
            ? dependency.slice(1)
            : path.join(path.dirname(file), dependency),
        );
    } else if (file.endsWith(".wxss")) {
      for (const [, dependency] of source.matchAll(
        /@import\s+["']([^"']+)["']/g,
      ))
        await include(path.join(path.dirname(file), dependency));
    }
  }
  async function includePage(page) {
    for (const ext of [".js", ".json", ".wxml", ".wxss"])
      await include(page + ext);
  }
  for (const file of ["app.js", "app.json", "app.wxss", "sitemap.json"])
    await include(file);
  for (const page of config.pages) await includePage(page);
  if (config.tabBar?.custom) await includePage("custom-tab-bar/index");
  for (const file of await walk(out)) {
    if (
      /\.(?:js|json|wxml|wxss)$/.test(file) &&
      !reachable.has(path.relative(out, file))
    )
      await fs.rm(file);
  }
}
// Native encoding is an independent module; publish notices and an exact source link.
const notices = path.resolve(
  import.meta.dirname,
  "../third-party/lamejs-1.2.7",
);
await fs.mkdir(`${out}/third-party/lamejs-1.2.7`, { recursive: true });
for (const name of [
  "NOTICE.md",
  "UPSTREAM-LICENSE.txt",
  "LGPL-3.0.txt",
  "GPL-3.0.txt",
])
  await fs.copyFile(
    path.join(notices, name),
    `${out}/third-party/lamejs-1.2.7/${name}`,
  );
for (const page of config.pages) {
  for (const ext of [".js", ".wxml", ".wxss", ".json"])
    await fs.access(`${out}/${page}${ext}`);
}
console.log(
  `Built ${config.pages.length} ${release ? "release" : "development"} native mini program pages → ${out}`,
);
