import { readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
type Server = {
  config: { base: string };
  middlewares: {
    use(
      path: string,
      handler: (
        request: IncomingMessage,
        response: ServerResponse,
        next: () => void,
      ) => void,
    ): unknown;
  };
};
/** Publish complete notices/source beside both browser builds. No product data lives here. */
export function lamejsLicense() {
  const root = new URL("../third-party/lamejs-1.2.7/", import.meta.url);
  const files = new Map(
    readdirSync(root).map((name) => [name, readFileSync(new URL(name, root))]),
  );
  const prefix = "third-party/lamejs-1.2.7/";
  return {
    name: "timenook-lamejs-license",
    generateBundle(this: {
      emitFile(asset: {
        type: "asset";
        fileName: string;
        source: Uint8Array;
      }): string;
    }) {
      for (const [name, source] of files)
        this.emitFile({ type: "asset", fileName: prefix + name, source });
    },
    configureServer(server: Server) {
      server.middlewares.use(
        server.config.base + prefix,
        (request, response, next) => {
          const name = request.url?.slice(1).split("?")[0] ?? "";
          const source = files.get(name);
          if (!source) return next();
          response.setHeader(
            "Content-Type",
            name.endsWith(".gz")
              ? "application/gzip"
              : "text/plain; charset=utf-8",
          );
          response.end(source);
        },
      );
    },
  };
}
