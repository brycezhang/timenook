// The route metadata augmentation used by Vben web-antd, without its app config.
import type { RouteMeta as VbenRouteMeta } from "@vben-core/typings";
import "vue-router";
declare module "vue-router" {
  interface RouteMeta extends VbenRouteMeta {}
}
