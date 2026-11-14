import { initPreferences } from "@vben/preferences";
import { overridesPreferences } from "./preferences";

async function bootstrap() {
  await initPreferences({
    namespace: "timenook-admin-v3",
    overrides: overridesPreferences,
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
