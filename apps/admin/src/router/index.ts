import { createRouter, createWebHistory, RouterView } from "vue-router";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import type { AdminPermission } from "@timenook/contracts";
import { useAccessStore, useTabbarStore } from "@vben/stores";
import { can, refreshSession, session, sessionError } from "../session";
const uuid = "[0-9a-fA-F-]{36}";
export function safeReturn(value: unknown): string {
  if (typeof value !== "string" || value.includes("\\") || /[\r\n]/.test(value))
    return "/orders";
  const path = value.split("?")[0];
  return new RegExp(
    `^/(orders|users|production)(/${uuid})?$|^/users/projects/${uuid}$`,
  ).test(path)
    ? value
    : "/orders";
}
export const businessMenus = [
  {
    name: "订单管理",
    path: "/orders",
    permission: ADMIN_PERMISSIONS.readOrders,
    icon: "lucide:shopping-bag",
  },
  {
    name: "用户管理",
    path: "/users",
    permission: ADMIN_PERMISSIONS.writeCare,
    icon: "lucide:users",
  },
  {
    name: "生产单管理",
    path: "/production",
    permission: ADMIN_PERMISSIONS.writeFulfillment,
    icon: "lucide:book-open",
  },
];
const pending = () => import("../views/pending.vue");
export const router = createRouter({
  history: createWebHistory("/admin/"),
  routes: [
    {
      path: "/auth",
      component: () => import("../layouts/auth.vue"),
      children: [
        {
          path: "login",
          name: "Login",
          component: () => import("../views/login.vue"),
          meta: { title: "运营登录", hideInTab: true },
        },
      ],
    },
    {
      path: "/",
      meta: { title: "运营管理", hideInBreadcrumb: true },
      component: () => import("../layouts/basic.vue"),
      children: [
        { path: "", name: "Home", redirect: "/orders" },
        {
          path: "orders",
          component: RouterView,
          meta: { title: "订单管理", permission: ADMIN_PERMISSIONS.readOrders },
          children: [
            {
              path: "",
              name: "Orders",
              component: () => import("../views/orders.vue"),
              meta: {
                title: "订单管理",
                hideInBreadcrumb: true,
                fullPathKey: false,
                keepAlive: false,
              },
            },
            {
              path: `:id(${uuid})`,
              name: "OrderDetail",
              component: () => import("../views/order-detail.vue"),
              meta: {
                title: "订单详情",
                activePath: "/orders",
                fullPathKey: false,
                keepAlive: false,
              },
            },
          ],
        },
        {
          path: "users",
          component: RouterView,
          meta: { title: "用户管理", permission: ADMIN_PERMISSIONS.writeCare },
          children: [
            {
              path: "",
              name: "Users",
              component: () => import("../views/users.vue"),
              meta: {
                title: "用户管理",
                hideInBreadcrumb: true,
                fullPathKey: false,
              },
            },
            {
              path: `:id(${uuid})`,
              name: "UserDetail",
              component: () => import("../views/user-detail.vue"),
              meta: {
                title: "用户详情",
                activePath: "/users",
                fullPathKey: false,
              },
            },
            {
              path: `projects/:projectId(${uuid})`,
              name: "ProjectDetail",
              component: () => import("../views/user-project.vue"),
              meta: {
                title: "项目详情",
                activePath: "/users",
                fullPathKey: false,
              },
            },
          ],
        },
        {
          path: "production",
          component: RouterView,
          meta: {
            title: "生产单管理",
            permission: ADMIN_PERMISSIONS.writeFulfillment,
          },
          children: [
            {
              path: "",
              name: "Production",
              component: pending,
              meta: {
                title: "生产单管理",
                hideInBreadcrumb: true,
                fullPathKey: false,
              },
            },
            {
              path: `:id(${uuid})`,
              name: "ProductionDetail",
              component: pending,
              meta: {
                title: "生产单详情",
                activePath: "/production",
                fullPathKey: false,
              },
            },
          ],
        },
        {
          path: "403",
          name: "Forbidden",
          component: () => import("../views/fallback.vue"),
          meta: { title: "无访问权限", status: "403" },
        },
        {
          path: ":pathMatch(.*)*",
          name: "NotFound",
          component: () => import("../views/fallback.vue"),
          meta: { title: "页面不存在", status: "404" },
        },
      ],
    },
  ],
});
function syncMenus() {
  const access = useAccessStore();
  access.setAccessMenus(businessMenus.filter((m) => can(m.permission)));
  access.setAccessRoutes(router.getRoutes());
}
router.beforeEach(async (to) => {
  if (!session.value) {
    try {
      await refreshSession();
    } catch {
      sessionError.value = "暂时无法连接运营入口，请重试。";
      if (to.name !== "Login")
        return { name: "Login", query: { redirect: safeReturn(to.fullPath) } };
      return true;
    }
  }
  syncMenus();
  if (!session.value?.authenticated) {
    if (to.name === "Login") return true;
    return {
      name: "Login",
      query: {
        redirect: safeReturn(to.fullPath),
        ...(to.query.login_error ? { login_error: to.query.login_error } : {}),
      },
    };
  }
  if (
    to.name === "Login" ||
    to.name === "Home" ||
    (to.redirectedFrom?.path === "/" &&
      sessionStorage.getItem("timenook-admin-return"))
  ) {
    const saved = sessionStorage.getItem("timenook-admin-return");
    sessionStorage.removeItem("timenook-admin-return");
    const target = safeReturn(saved ?? to.query.redirect);
    const resolved = router.resolve(target);
    const permission = resolved.meta.permission as AdminPermission | undefined;
    const destination =
      permission && can(permission)
        ? target
        : (businessMenus.find((m) => can(m.permission))?.path ?? "/403");
    if (to.fullPath !== destination) return destination;
  }
  const permission = to.meta.permission as AdminPermission | undefined;
  if (permission && !can(permission))
    return to.redirectedFrom?.path === "/"
      ? (businessMenus.find((m) => can(m.permission))?.path ?? "/403")
      : "/403";
});
router.afterEach((to) => {
  if (session.value?.authenticated && to.name !== "Login") {
    useTabbarStore().addTab(to);
    document.title = `${String(to.meta.title ?? "运营管理")} · 时光里`;
  }
});
window.addEventListener("admin-session-expired", () => {
  void router.replace({
    name: "Login",
    query: { redirect: safeReturn(router.currentRoute.value.fullPath) },
  });
});
window.addEventListener("admin-permission-changed", () => {
  syncMenus();
  useTabbarStore().$reset();
  void router.replace("/403");
});
