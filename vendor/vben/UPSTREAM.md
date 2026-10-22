# Vben source provenance

Vben 5.7.0 from the tracked Git tree of the read-only engineering reference `wutong-admin`, commit `191d4388690ba2298d3b93fb5c929a5adcc761a2`. Original project: https://github.com/vbenjs/vue-vben-admin (MIT, LICENSE retained here).

Only the source dependency closure for `@vben-core/layout-ui`, `@vben/preferences`, `@vben/request` and `@vben/styles` is included. No app, backend, private configuration, demos, generated build, or credentials are copied. Package manifests remove upstream build/publish/test tooling, expand catalog ranges and point exports at the retained source. These are source packages compiled by the TimeNook web-antd app; application-specific behavior lives in apps/admin.

| Local package | Reference path |
| --- | --- |
| @vben-core/composables | packages/@core/composables |
| @vben-core/design | packages/@core/base/design |
| @vben-core/icons | packages/@core/base/icons |
| @vben-core/layout-ui | packages/@core/ui-kit/layout-ui |
| @vben-core/preferences | packages/@core/preferences |
| @vben-core/shadcn-ui | packages/@core/ui-kit/shadcn-ui |
| @vben-core/shared | packages/@core/base/shared |
| @vben-core/typings | packages/@core/base/typings |
| @vben/locales | packages/locales |
| @vben/preferences | packages/preferences |
| @vben/request | packages/effects/request |
| @vben/styles | packages/styles |
| @vben/tailwind-config | internal/tailwind-config |
| @vben/utils | packages/utils |

CSS also requires the upstream @vben/tailwind-config package (an undeclared design dependency, made explicit here); its source scan paths are adapted to this repository. Catalog dependency ranges are pinned to the reference versions. The reference tree lacks a root LICENSE file; the original MIT notice was retrieved from https://raw.githubusercontent.com/vbenjs/vue-vben-admin/main/LICENSE on 2026-10-22.

Compatibility changes: restored type-only dev dependencies needed when consuming source; made the shadcn CSS theme dependency explicit; removed one stale `@ts-expect-error` in layout-content.vue (Vue 3.5/vue-tsc 3.2 reports it unused). `apps/admin/src/route-meta.d.ts` retains only the route metadata augmentation from `packages/types/global.d.ts`, excluding reference app runtime configuration.

The upstream menu helper now uses a redirect only when it is a string; Vue Router also permits redirect objects/functions, which cannot be a menu path. This narrows the original fallback and fixes source typechecking (the T07 app has no dynamic menu routes).
