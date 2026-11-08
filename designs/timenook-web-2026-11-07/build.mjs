import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../..");
const require = createRequire(path.join(repo, "apps/admin/package.json"));
const { parse, compileScript } = require("vue/compiler-sfc");
const { build } = createRequire(path.join(repo, "package.json"))("esbuild");
const tokens = JSON.parse(
  fs.readFileSync(path.join(root, "design-system/project/tokens.json"), "utf8"),
);
let tokenCss = ":root{";
for (const family of ["color", "spacing", "radius"])
  for (const t of tokens[family].tokens) tokenCss += `--${t.name}:${t.value};`;
tokenCss += "}\n";
fs.writeFileSync(path.join(root, "tokens.css"), tokenCss);
const names = [
  "book-open",
  "gift",
  "settings",
  "layout-dashboard",
  "notebook-pen",
  "layers-2",
  "user-round",
  "chevrons-up-down",
  "chevron-right",
  "chevron-left",
  "arrow-right",
  "arrow-left",
  "arrow-up-right",
  "user-round-plus",
  "heart",
  "sprout",
  "refresh-cw",
  "lock-keyhole",
  "plus",
  "search",
  "mic",
  "audio-lines",
  "pencil",
  "book-minus",
  "book-plus",
  "pause",
  "play",
  "square",
  "check",
  "loader-circle",
  "sparkles",
  "package",
  "file-text",
  "x",
  "users-round",
  "shield-check",
  "link",
  "circle-help",
];
const icons = {};
for (const name of names)
  icons[name] = fs.readFileSync(
    path.join(repo, `node_modules/lucide-static/icons/${name}.svg`),
    "utf8",
  );
fs.writeFileSync(
  path.join(root, "src/icons.ts"),
  "// Lucide icons, ISC licensed. Copied from the installed lucide-static package.\nexport default " +
    JSON.stringify(icons) +
    " as Record<string,string>;\n",
);
await build({
  stdin: {
    contents:
      "import {createApp} from 'vue';import App from './App.vue';createApp(App).mount('#app');",
    resolveDir: path.join(root, "src"),
    sourcefile: "main.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  outfile: path.join(root, "app.js"),
  minify: true,
  define: {
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    "process.env.NODE_ENV": '"production"',
  },
  alias: {
    vue: path.join(
      repo,
      "apps/admin/node_modules/vue/dist/vue.runtime.esm-bundler.js",
    ),
  },
  plugins: [
    {
      name: "vue-sfc",
      setup(b) {
        b.onLoad({ filter: /\.vue$/ }, async (args) => {
          const source = fs.readFileSync(args.path, "utf8");
          const { descriptor } = parse(source, { filename: args.path });
          const script = compileScript(descriptor, {
            id: args.path,
            inlineTemplate: true,
          });
          return {
            contents: script.content,
            loader: "ts",
            resolveDir: path.dirname(args.path),
          };
        });
      },
    },
  ],
});
fs.copyFileSync(path.join(root, "src/style.css"), path.join(root, "style.css"));
console.log("Built Vue 3 design prototype: " + path.join(root, "index.html"));
