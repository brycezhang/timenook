// Loopback transport fixture: drop one successful first-copy submit response
// after the real upstream has completed it. All other API/binary bytes stream.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const root = path.resolve(process.env.TIMENOOK_REPO || process.cwd());
const directory =
  process.env.TIMENOOK_MP12_TRANSPORT_DIR ||
  path.join(root, "test-results/mp12-transport-native");
const manifestFile = path.join(directory, "fixture.json");
const controlFile = path.join(directory, "arm.json");
const statusFile = path.join(directory, "status.json");
const submitPath = /^\/v1\/projects\/[a-f0-9-]{36}\/first-copy\/submit$/;
function writePrivate(file, value) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = file + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}
function control(action) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  process.kill(manifest.pid, 0);
  if (action === "arm") {
    const projectId = process.argv[3];
    assert.match(projectId || "", /^[a-f0-9-]{36}$/);
    writePrivate(controlFile, {
      runId: manifest.runId,
      path: `/v1/projects/${projectId}/first-copy/submit`,
    });
    console.log("Armed one successful print-submit response loss.");
  } else if (action === "disarm") {
    writePrivate(controlFile, { runId: manifest.runId, disarm: true });
    console.log("Disarmed the next print-submit response loss.");
  } else if (action === "status") {
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    console.log(
      JSON.stringify({ ...status, commandPending: fs.existsSync(controlFile) }),
    );
  } else throw Error("Use: serve | arm PROJECT_ID | disarm | status");
}
function serve() {
  const upstream = new URL(
    process.env.TIMENOOK_MP12_PROXY_UPSTREAM || "http://127.0.0.1:3428/v1",
  );
  assert.equal(upstream.protocol, "http:");
  assert.ok(["127.0.0.1", "localhost"].includes(upstream.hostname));
  assert.equal(upstream.pathname.replace(/\/$/, ""), "/v1");
  assert.ok(
    !upstream.username &&
      !upstream.password &&
      !upstream.search &&
      !upstream.hash,
  );
  const port = Number(process.env.TIMENOOK_MP12_PROXY_PORT || 3430);
  assert.ok(
    Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535)),
  );
  const runId = randomUUID();
  let armedPath = null,
    candidate = false,
    closing = false;
  const status = {
    phase: "idle",
    armed: false,
    droppedResponses: 0,
    forwardedResponses: 0,
    lastUpstreamStatus: null,
  };
  const save = () =>
    writePrivate(statusFile, { ...status, armed: !!armedPath });
  const loadControl = () => {
    if (!fs.existsSync(controlFile)) return;
    const command = JSON.parse(fs.readFileSync(controlFile, "utf8"));
    fs.unlinkSync(controlFile);
    if (command.runId !== runId) return;
    if (command.disarm) armedPath = null;
    else {
      assert.match(command.path, submitPath);
      armedPath = command.path;
    }
    status.phase = armedPath ? "armed" : "idle";
    save();
  };
  const hop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const headers = (input) => {
    const connectionHeaders = String(input.connection || "")
      .toLowerCase()
      .split(",")
      .map((v) => v.trim());
    return Object.fromEntries(
      Object.entries(input).filter(
        ([key]) => !hop.has(key) && !connectionHeaders.includes(key),
      ),
    );
  };
  const server = http.createServer((incoming, outgoing) => {
    try {
      loadControl();
    } catch {
      status.phase = "invalid-control";
      save();
    }
    if (!incoming.url?.startsWith("/v1/")) {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const matches =
      !candidate && incoming.method === "POST" && incoming.url === armedPath;
    if (matches) {
      candidate = true;
      status.phase = "awaiting-upstream";
      save();
    }
    const forwarded = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...headers(incoming.headers), host: upstream.host },
      },
      (response) => {
        const success = response.statusCode >= 200 && response.statusCode < 300;
        if (matches && success) {
          // Do not fabricate a response or abort the command. Wait until the
          // successful API response has completely arrived, then lose it locally.
          response.once("end", () => {
            candidate = false;
            armedPath = null;
            status.phase = "dropped-after-upstream-success";
            status.lastUpstreamStatus = response.statusCode;
            ++status.droppedResponses;
            save();
            outgoing.destroy();
          });
          response.once("error", () => {
            candidate = false;
            status.phase = "upstream-response-error";
            save();
            outgoing.destroy();
          });
          response.resume();
          return;
        }
        if (matches) {
          candidate = false;
          status.phase = "forwarded-upstream-rejection";
          status.lastUpstreamStatus = response.statusCode;
          save();
        }
        outgoing.writeHead(
          response.statusCode,
          response.statusMessage,
          headers(response.headers),
        );
        response.once("end", () => {
          ++status.forwardedResponses;
          save();
        });
        response.once("error", () => outgoing.destroy());
        response.pipe(outgoing);
      },
    );
    forwarded.once("error", () => {
      if (matches) {
        candidate = false;
        status.phase = "upstream-request-error";
        save();
      }
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.once("aborted", () => forwarded.destroy());
    outgoing.once("close", () => {
      if (!outgoing.writableEnded && !matches) forwarded.destroy();
    });
    incoming.pipe(forwarded);
  });
  server.once("error", () => {
    console.error(
      "MP12 loopback transport could not listen; existing services untouched.",
    );
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const actualPort = server.address().port;
    save();
    writePrivate(manifestFile, {
      pid: process.pid,
      runId,
      proxyApiBase: `http://127.0.0.1:${actualPort}/v1`,
      upstreamApiBase: upstream.href.replace(/\/$/, ""),
      controlFile,
      statusFile,
      boundary:
        "Real upstream API. One opt-in successful submit response is discarded only after upstream completion. No business response mocks.",
    });
    console.log(
      `MP12 loopback transport ready on ${actualPort}; private manifest saved outside Git.`,
    );
  });
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      for (const file of [manifestFile, controlFile, statusFile]) {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 5000).unref();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
try {
  process.argv[2] && process.argv[2] !== "serve"
    ? control(process.argv[2])
    : serve();
} catch {
  console.error(
    "Transport fixture command failed; inspect private local configuration.",
  );
  process.exitCode = 1;
}
