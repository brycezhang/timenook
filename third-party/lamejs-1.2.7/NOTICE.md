# @breezystack/lamejs 1.2.7

Browser MP3 encoding uses the unmodified ESM library by Alex Zhukov and contributors, distributed under **LGPL-3.0**, not the application's license. Copyright notices remain in the library/source. The original published LICENSE and README and the complete LGPL v3 / GPL v3 texts are included here. The LGPL permits replacement of this independently loaded module; TimeNook does not prohibit reverse engineering to debug modifications to this library.

- npm release: https://registry.npmjs.org/@breezystack/lamejs/-/lamejs-1.2.7.tgz
- release integrity: `sha512-6wc7ck65ctA75Hq7FYHTtTvGnYs6msgdxiSUICQ+A01nVOWg6rqouZB8IdyteRlfpYYiFovkf67dIeOgWIUzTA==`
- release gitHead: `1fb0ef5fa177413107e2e107d054a9b994e3f79c`
- corresponding source, build instructions, package manifest and lockfile: [source.tar.gz](source.tar.gz), from https://github.com/gideonstele/lamejs/tree/1fb0ef5fa177413107e2e107d054a9b994e3f79c (npm metadata's shijinyu/lamejs repository redirects here).

The Worker dynamically imports the separate, original `dist/lamejs.js` asset; no library code is copied into the application's main or Worker bundle, modified, or minified by TimeNook. To replace/relink it, install an alternate compatible package, rebuild, or replace the separately emitted ESM asset at its referenced URL. Preserve its module interface `Mp3Encoder`; changing encoder parameters or output framing requires independent duration/format validation.

The browser build publishes these files at `third-party/lamejs-1.2.7/` alongside the application, including the complete corresponding source archive, rather than relying only on an upstream download link. To build the upstream library, extract the source archive, install the package's pinned dependencies using its package manifest and pnpm lockfile, then run its `build` script. The source is provided in its preferred form for modification.
