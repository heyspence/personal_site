// chat-proxy.mjs — zero-dependency reverse proxy for the Lab Chat widget.
//
// The public site used to ship its gateway API key inside lab-chat.js and call
// the AgentGateway endpoints straight from visitors' browsers, so the key was
// readable in anyone's page source. This service replaces that: nginx routes
// /chat-proxy/ on spencerheywood.com to 127.0.0.1:8791, the browser calls it
// on the site's own origin with no credentials, and this process injects the
// key server-side before forwarding upstream (see README.md).
//
// Requires Node 18+ (uses global fetch). No npm dependencies.

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- Configuration -----------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (KEY=VALUE lines) so the same file works under systemd
// and when run by hand. Real environment variables always win over .env.
(function loadDotEnv() {
    const envFile = path.join(here, ".env");
    if (!existsSync(envFile)) return;
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[match[1]] ??= value;
    }
})();

const HOST = process.env.CHAT_PROXY_HOST || "127.0.0.1"; // behind nginx — never bind public here
const PORT = Number(process.env.CHAT_PROXY_PORT || 8791);
// Trailing slashes stripped so request paths can be appended cleanly.
const LLM_UPSTREAM = (process.env.LLM_GATEWAY_URL || "https://llm.spencerheywood.com").replace(/\/+$/, "");
const MCP_UPSTREAM = (process.env.MCP_GATEWAY_URL || "https://mcp.spencerheywood.com").replace(/\/+$/, "");
const API_KEY = process.env.LAB_CHAT_API_KEY;

if (!API_KEY) {
    console.error("chat-proxy: LAB_CHAT_API_KEY is missing. Put it in server/.env (gitignored) or the environment.");
    process.exit(1);
}

// --- Routing -------------------------------------------------------------------
// The chat widget only ever hits two entry points, so only those are proxied;
// anything else gets a 404 and can't be used to reach other gateway endpoints.

function routeFor(url) {
    if (url.pathname === "/v1/chat/completions") return LLM_UPSTREAM + url.pathname;
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return MCP_UPSTREAM + url.pathname;
    return null;
}

// Headers never forwarded in either direction: host is rewritten per request,
// content-length would be wrong once we re-encode the body, accept-encoding is
// forced to identity so upstream bytes pass through unchanged, and any client
// Authorization header is dropped on purpose — the key only ever comes from us.
const HOP_HEADERS = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "authorization"
]);

const MAX_BODY_BYTES = 5 * 1024 * 1024; // chat payloads are a few KB; cap the rest

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error("payload too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function proxy(req, res, targetUrl) {
    const startedAt = Date.now();
    const urlPath = targetUrl.split("/").slice(-2).join("/");

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
        try {
            body = await readBody(req);
        } catch {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "payload too large" }));
            return;
        }
    }

    // If the visitor's socket dies mid-request (tab closed), stop paying for
    // generation on the upstream model.
    const upstreamAbort = new AbortController();
    req.socket.on("close", () => upstreamAbort.abort());

    try {
        const headers = {};
        for (const [name, value] of Object.entries(req.headers)) {
            if (!HOP_HEADERS.has(name)) headers[name] = value;
        }
        headers.authorization = `Bearer ${API_KEY}`;

        const upstream = await fetch(targetUrl, {
            method: req.method,
            headers,
            body,
            signal: upstreamAbort.signal
        });

        res.statusCode = upstream.status;
        for (const [name, value] of upstream.headers.entries()) {
            if (!HOP_HEADERS.has(name)) res.setHeader(name, value);
        }

        if (upstream.body) {
            await pipeline(Readable.fromWeb(upstream.body), res);
        } else {
            res.end();
        }

        console.log(`${req.method} ${urlPath} -> ${upstream.status} (${Date.now() - startedAt} ms)`);
    } catch (error) {
        if (!res.headersSent) {
            // fetch failed before any response reached us. 499 mirrors "client closed".
            res.writeHead(error.name === "AbortError" ? 499 : 502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "chat proxy upstream unreachable" }));
        } else {
            // Headers already sent and the body cut short — the client's own
            // timeout/retry logic in lab-chat.js handles this.
            res.destroy();
        }
        console.warn(`${req.method} ${urlPath} failed after ${Date.now() - startedAt} ms:`, error.message);
    }
}

const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    const target = routeFor(url);
    if (!target) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
    }

    proxy(req, res, `${target}${url.search}`);
});

server.listen(PORT, HOST, () => {
    console.log(`chat-proxy listening on http://${HOST}:${PORT} (LLM -> ${LLM_UPSTREAM}, MCP -> ${MCP_UPSTREAM})`);
});
