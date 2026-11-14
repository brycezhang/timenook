import { defineOverridesPreferences } from "@vben/preferences";

export const adminName = "时光故事管理后台";

export const overridesPreferences = defineOverridesPreferences({
  app: {
    name: adminName,
    defaultHomePath: "/orders",
    layout: "sidebar-nav",
    authPageLayout: "panel-center",
    enablePreferences: false,
    enableCheckUpdates: false,
  },
  breadcrumb: { showHome: false, showIcon: false },
  copyright: { enable: false },
  header: { height: 56 },
  logo: { source: "" },
  navigation: { accordion: false, split: false, styleType: "rounded" },
  sidebar: {
    width: 248,
    collapseWidth: 64,
    draggable: false,
    fixedButton: false,
    // Vben's pinned state reserves the sidebar width even while it is hovered.
    expandOnHover: true,
  },
  tabbar: {
    enable: true,
    keepAlive: false,
    persist: false,
    visitHistory: false,
  },
  theme: { mode: "light" },
  transition: { enable: false },
  widget: {
    globalSearch: false,
    lockScreen: false,
    notification: false,
    timezone: false,
    languageToggle: false,
    fullscreen: false,
    themeToggle: false,
    refresh: false,
    sidebarToggle: false,
  },
});
