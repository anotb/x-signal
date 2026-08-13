import http from "node:http";

const value = process.env.XSIGNAL_CLIPBOARD_VALUE;
if (!value) throw new Error("XSIGNAL_CLIPBOARD_VALUE is required.");
const port = Number.parseInt(process.env.XSIGNAL_CLIPBOARD_PORT ?? "7350", 10);
const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const html = `<!doctype html><meta charset="utf-8"><title>X Signal setup bridge</title><label>Temporary setup value <input autofocus readonly value="${escaped}"></label>`;

const server = http.createServer((request, response) => {
  if (request.url !== "/") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
  response.end(html);
});

server.listen(port, "127.0.0.1");
setTimeout(() => server.close(() => process.exit(0)), 120_000).unref();
