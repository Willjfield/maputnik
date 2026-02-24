import type { ServerResponse } from "http";
import type { Plugin } from "vite";
import { loadEnv } from "vite";

const PROXY_PATH = "/api/anthropic/messages";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_FETCH_TIMEOUT_MS = 300_000; // 5 minutes – full style edit can be slow
const BODY_TIMEOUT_MS = 30_000;

function sendJson(res: ServerResponse, status: number, body: object) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Vite plugin that proxies POST /api/anthropic/messages to the Anthropic API.
 * Use in development to avoid CORS; the API key is read from .env (ANTHROPIC_API_KEY)
 * and never sent to the client.
 */
export function anthropicProxyPlugin(): Plugin {
  return {
    name: "anthropic-proxy",
    configureServer(server) {
      const mode = process.env.MODE ?? "development";
      const env = loadEnv(mode, process.cwd(), "");
      const apiKey = env.ANTHROPIC_API_KEY;
      const fetchTimeoutMs = env.ANTHROPIC_PROXY_TIMEOUT_MS
        ? Math.max(60_000, parseInt(env.ANTHROPIC_PROXY_TIMEOUT_MS, 10) || DEFAULT_FETCH_TIMEOUT_MS)
        : DEFAULT_FETCH_TIMEOUT_MS;

      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        const isProxyPath = pathname === PROXY_PATH || pathname.endsWith(PROXY_PATH);
        if (req.method !== "POST" || !isProxyPath) {
          next();
          return;
        }

        // Help debug "stuck" requests: check terminal for this line when you submit
        console.log("[anthropic-proxy] POST /api/anthropic/messages – forwarding to Anthropic…");

        const key = apiKey;
        if (!key?.trim()) {
          sendJson(res, 500, { error: "ANTHROPIC_API_KEY is not set. Add it to a .env file in the project root and restart the dev server." });
          return;
        }

        let body = "";
        let bodyDone = false;
        const bodyTimeout = setTimeout(() => {
          if (bodyDone) return;
          bodyDone = true;
          sendJson(res, 408, { error: "Request body timeout. The request was too slow or too large." });
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
          const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);

          fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": key,
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
                sendJson(res, 504, { error: "Request to Anthropic timed out. Try a shorter prompt or try again." });
              } else {
                sendJson(res, 502, { error: err instanceof Error ? err.message : "Proxy request failed" });
              }
            });
        });
      });
    },
  };
}
