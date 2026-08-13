import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

const token = process.env.XSIGNAL_TUNNEL_PATH_TOKEN?.trim();
if (!token || token.length < 24) throw new Error("XSIGNAL_TUNNEL_PATH_TOKEN must contain at least 24 characters.");
const port = Number.parseInt(process.env.XSIGNAL_TUNNEL_PROXY_PORT ?? "7346", 10);
const target = new URL(process.env.XSIGNAL_TUNNEL_TARGET ?? "http://127.0.0.1:7345/mcp");
const expected = createHash("sha256").update(token).digest();

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const supplied = requestUrl.pathname.replace(/^\/+|\/+$/g, "");
  const actual = createHash("sha256").update(supplied).digest();
  if (!timingSafeEqual(expected, actual)) {
    response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"NOT_FOUND"}');
    return;
  }

  const headers = { ...request.headers, host: target.host };
  delete headers["content-length"];
  const upstream = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"UPSTREAM_UNAVAILABLE"}');
  });
  request.pipe(upstream);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(JSON.stringify({ status: "ready", address: `http://127.0.0.1:${boundPort}/<redacted>`, port: boundPort }) + "\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
