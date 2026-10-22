import { createApplication } from "./application";
import { ConfigurationError, readConfig } from "./config";

async function main(): Promise<void> {
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const config = readConfig(process.env);
    app = await createApplication(config);
    app.enableShutdownHooks();
    await app.listen(config.port, config.host);
    console.info(`TimeNook API listening at ${await app.getUrl()}`);
  } catch (error) {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : "API startup failed",
    );
    await app?.close();
    process.exitCode = 1;
  }
}

void main();
