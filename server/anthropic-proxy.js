#!/usr/bin/env node
/**
 * Standalone proxy for Anthropic Messages API.
 * Run behind nginx so the API key stays server-side (never sent to the browser).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node server/anthropic-proxy.js
 *   # Listens on http://127.0.0.1:3000 by default. Set PORT to change.
 *
 * Nginx should proxy POST /api/anthropic/messages to this server.
 */

const http = require("http");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const PROXY_PATH = "/api/anthropic/messages";
const DEFAULT_PORT = 3000;
const BODY_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = Number(process.env.ANTHROPIC_PROXY_TIMEOUT_MS) || 300_000;

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const pathname = req.url?.split("?")[0] ?? "";
  const isProxyPath = pathname === PROXY_PATH || pathname.endsWith(PROXY_PATH);

  if (req.method !== "POST" || !isProxyPath) {
    res.statusCode = 404;
    res.end();
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.trim()) {
    sendJson(res, 500, { error: "ANTHROPIC_API_KEY is not set on the server." });
    return;
  }

  let body = "";
  let bodyDone = false;
  const bodyTimeout = setTimeout(() => {
    if (bodyDone) return;
    bodyDone = true;
    sendJson(res, 408, { error: "Request body timeout." });
    req.destroy();
  }, BODY_TIMEOUT_MS);

  req.on("data", (chunk) => { body += chunk; });
  req.on("error", () => {
    if (!bodyDone && !res.headersSent) sendJson(res, 500, { error: "Request stream error." });
    bodyDone = true;
  });
  req.on("end", () => {
    clearTimeout(bodyTimeout);
    if (bodyDone) return;
    bodyDone = true;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      signal: controller.signal,
    })
      .then(async (proxyRes) => {
        clearTimeout(timeoutId);
        const text = await proxyRes.text();
        if (!res.headersSent) {
          res.statusCode = proxyRes.status;
          res.setHeader("Content-Type", proxyRes.headers.get("Content-Type") || "application/json");
          res.end(text);
        }
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        if (res.headersSent) return;
        if (err?.name === "AbortError") {
          sendJson(res, 504, { error: "Request to Anthropic timed out." });
        } else {
          sendJson(res, 502, { error: err?.message || "Proxy request failed" });
        }
      });
  });
});

const port = Number(process.env.PORT) || DEFAULT_PORT;
server.listen(port, "127.0.0.1", () => {
  console.log(`[anthropic-proxy] Listening on http://127.0.0.1:${port} (proxy path: ${PROXY_PATH})`);
});
