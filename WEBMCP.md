# WebMCP support

This site exposes [WebMCP](https://webmachinelearning.github.io/webmcp/) tools, so browser AI assistants that speak the standard (Chrome 149+ via origin trial or `chrome://flags/#enable-webmcp-testing`, ChatGPT Desktop) can use the page directly instead of scraping the DOM. It is a progressive enhancement — nothing about the site changes for browsers without it.

This is deliberately the opposite direction from Lab Chat: `lab-chat.js` makes this *page* an MCP client of the AgentGateway; WebMCP makes this page a tool server for whatever assistant opens it in the visitor's browser. No keys or credentials are involved — every tool hits endpoints that are already public to any visitor.

## Exposed tools (registered by `webmcp.js`)

| Tool | What it does | Data source |
| --- | --- | --- |
| `get_live_lab_stats` | Live lab numbers: tok/s throughput, lifetime tokens/requests, cost vs API spend avoided, power, energy, GPU utilization, local/overflow routing, top models. No parameters | `GET https://llm.spencerheywood.com/api/usage` (same feed the stats panel polls) |
| `ask_local_model` | Asks a question (`question`, required, ≤600 chars) of the LLM running on Spencer's hardware; returns its plain-text answer. Single-shot, max 512 output tokens | `POST /chat-proxy/v1/chat/completions` (same keyless path as Lab Chat) |
| `navigate_to_section` | Smooth-scrolls to a page section (`section`, required enum: `live-stats`, `focus`, `experience`, `delivery-process`, `ai-lab`, `projects`, `capabilities`, `education`, `contact`) | DOM anchors in `index.html` |

The email-sending capability is **not** exposed as a WebMCP tool on purpose — visitors who want to email Spencer still have Lab Chat and the contact links. If you ever want it, add a fourth tool mirroring the MCP call in `lab-chat.js`.

## Files

- `webmcp.js` — registers the tools above on `document.modelContext`
- `vendor/webmcp-polyfill.js` — vendored from Google's [webmcp-tools](https://github.com/GoogleChromeLabs/webmcp-tools) (Apache-2.0). Provides `document.modelContext` in browsers without native support so dev tools can still discover and call the tools; no-ops where the API exists natively
- `index.html` — loads polyfill then tools, both deferred after the existing scripts

## Testing

1. **Chrome (native path):** enable the flag above (or enroll for the origin trial), load the site, open DevTools console and look for `[webmcp] exposed tools: …`. Then ask Gemini in Chrome something like "what's the current aggregate tok/s?" — it should call `get_live_lab_stats` rather than reading numbers off the page.
2. **Any browser (polyfill path):** install Google's [Model Context Tool Inspector](https://github.com/beaufortfrancois/model-context-tool-inspector) extension and open the site — the tools show up in its panel and can be invoked manually with sample inputs to verify schemas and error messages.

## Native-support caveats (Chrome)

- WebMCP requires an **origin-isolated** document. If `spencerheywood.com` doesn't already send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, the native API stays disabled even in Chrome 149+ (the polyfill path still works). The only third-party resources are Google Fonts, which serve proper CORS headers, so enabling both headers on the nginx vhost should be safe — verify fonts/images still load after adding them.
- Tool registration is gated by the `tools` Permissions Policy, defaulting to `self` — fine for this top-level page; it only matters if this site ever gets embedded in a cross-origin iframe (would need `allow="tools"`).
