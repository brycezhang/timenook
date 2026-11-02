import { initPreferences } from "@vben/preferences";
async function bootstrap() {
  await initPreferences({
    namespace: "timenook-admin-v2",
    overrides: {
      app: {
        name: "时光里运营管理",
        defaultHomePath: "/orders",
        enablePreferences: false,
        enableCheckUpdates: false,
        authPageLayout: "panel-center",
        contentPadding: 20,
      },
      theme: { mode: "light" },
      logo: { source: "" },
      copyright: { enable: false },
      tabbar: {
        enable: true,
        keepAlive: false,
        persist: false,
        visitHistory: false,
      },
      widget: {
        globalSearch: false,
        lockScreen: false,
        notification: false,
        timezone: false,
        languageToggle: false,
        fullscreen: false,
        themeToggle: false,
      },
      sidebar: {
        collapsedButton: false,
        fixedButton: false,
        draggable: false,
        expandOnHover: false,
      },
      transition: { enable: false },
    },
  });
  const [
    { createApp },
    { createPinia },
    { setupI18n },
    { default: App },
    { router },
  ] = await Promise.all([
    import("vue"),
    import("pinia"),
    import("@vben/locales"),
    import("./app.vue"),
    import("./router"),
  ]);
  await import("@vben/styles");
  await import("@vben/styles/antdv-next");
  await import("./style.css");
  const app = createApp(App);
  app.use(createPinia());
  await setupI18n(app, { defaultLocale: "zh-CN" });
  app.use(router);
  await router.isReady();
  app.mount("#app");
}
void bootstrap();
