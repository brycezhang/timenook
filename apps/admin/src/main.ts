import { initPreferences } from "@vben/preferences";
async function bootstrap() {
  await initPreferences({
    namespace: "timenook-admin-v1",
    overrides: {
      app: {
        name: "时光里运营管理",
        enablePreferences: false,
        enableCheckUpdates: false,
      },
      theme: { mode: "light" },
    },
  });
  const [{ createApp }, { default: App }] = await Promise.all([
    import("vue"),
    import("./app.vue"),
  ]);
  await import("@vben/styles");
  await import("@vben/styles/antdv-next");
  await import("./style.css");
  createApp(App).mount("#app");
}
void bootstrap();
