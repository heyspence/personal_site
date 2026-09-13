# `GET /api/usage` — spec for the site's Live Lab Stats panel

Hand this to the backend agent on the LLM box. The frontend is already built and polls this endpoint; every field below maps directly to something rendered on spencerheywood.com.

## Endpoint requirements

| Requirement | Detail |
| --- | --- |
| Method / path | `GET https://llm.spencerheywood.com/api/usage` |
| Content-Type | `application/json` |
| CORS | Same `Access-Control-Allow-Origin` setup as the existing `/api/tokens` endpoint (the site is a different origin: `spencerheywood.com`) |
| Caching | Aggregates change slowly. Suggested header: `Cache-Control: public, max-age=300`. The site polls every 60 s and tolerates stale data fine |
| Existing endpoints | **Do not touch** `/api/tokens` or `/inflight.json` — the live counter and active-streams gauge still use them. This is a separate, additive endpoint |

## Response schema (example payload)

```json
{
  "updated_at_utc": "2026-09-13T17:01:45Z",
  "lifetime": {
    "started_at_utc": "2025-11-02T14:22:10Z",
    "tokens": {
      "total": 84210000,
      "input": 61230000,
      "output": 22980000
    },
    "requests": 41200,
    "local_tokens": 80990000,
    "api_overflow_tokens": 3220000
  },
  "cost": {
    "setup_cost_usd": 14000,
    "api_cost_saved_usd": 498.37,
    "reference_note": "Blended across models actually served \u00b7 OpenRouter list pricing",
    "model_rates_usd_per_mtok": {
      "qwen3.8-27b": { "input": 0.42, "output": 3.0 },
      "qwen3.5-122b-a10b": { "input": 0.29, "output": 2.4 }
    }
  },
  "power": {
    "average_w": 500,
    "peak_w": 1850
  },
  "energy": {
    "kwh_lifetime": 1580.4
  },
  "throughput": {
    "peak_tok_s": 412.5,
    "avg_24h_tok_s": 28.3,
    "mean_tok_s": 11.7
  },
  "utilization": {
    "percent": 42.6,
    "window_days": 30
  },
  "routing": {
    "local_percent": 96.2,
    "api_overflow_percent": 3.8
  },
  "top_models": [
    { "model": "qwen3.8-flash-next@iq4_xs", "tokens": 51000000, "share_percent": 60.6 },
    { "model": "qwen3.8-27b", "tokens": 20100000, "share_percent": 23.9 },
    { "model": "gemma-4-12b-qat", "tokens": 13110000, "share_percent": 15.5 }
  ]
}
```

## Field definitions

| Field | Type | Definition / how to compute |
| --- | --- | --- |
| `updated_at_utc` | string (ISO 8601) | When the aggregate was last computed. The site uses it as a dedupe key — identical values skip the re-render |
| `lifetime.started_at_utc` | string (ISO 8601) | **First token recorded on the current build** (V3, RTX PRO 6000 workstation). Anchors "days in service" and payback against the $14k setup cost |
| `lifetime.tokens.total` | int | Lifetime tokens across **all routes** (local + API overflow). Must equal `input + output` |
| `lifetime.tokens.input` | int | Prompt-side tokens lifetime |
| `lifetime.tokens.output` | int | Completion-side tokens lifetime |
| `lifetime.requests` | int | Completion requests served, all routes |
| `lifetime.local_tokens` | int | Tokens served by local models (same population `/api/tokens` sums over its local model tags) |
| `lifetime.api_overflow_tokens` | int | Tokens the gateway forwarded to hosted APIs when local was saturated. Should satisfy `local_tokens + api_overflow_tokens ≈ total` |
| `cost.setup_cost_usd` | number | One-time hardware/build cost, currently **14000**. Site falls back to 14000 if omitted |
| `cost.api_cost_saved_usd` | number | Estimated hosted cost of the lifetime tokens, summed **per model at that model's own list price**: for each client-facing tag (after alias folding), `(input / 1e6) \u00d7 input_rate + (output / 1e6) \u00d7 output_rate`. Rates come from `model_rates_usd_per_mtok` in the gateway's `usage_config.json`; tags with no configured rate (local-only rerankers/embedders have no hosted equivalent) are excluded |
| `cost.reference_note` | string, optional | Display text for the UI footnote under "API cost avoided" — states what pricing basis the estimate uses. Site falls back to generic copy when absent |
| `cost.model_rates_usd_per_mtok` | object, optional | The exact per-model rates used (USD/MTok, `input`/`output`) so the math is auditable — echoed from config for tags that had priced tokens |
| `power.average_w` | number | Average wall-draw **while generating**. Measured figure: ~500 W at 3 concurrent streams. Displayed verbatim in the UI |
| `power.peak_w` | number, optional | Peak observed wall draw |
| `energy.kwh_lifetime` | number | Cumulative wall energy (kWh). Use a meter if available; otherwise estimate from generation time × power draw — the UI labels it an estimate either way |
| `throughput.peak_tok_s` | number | Highest single-stream generation rate observed, tokens/sec |
| `throughput.avg_24h_tok_s` | number | Tokens generated in the last 24 h ÷ 86 400 — the sustained-rate picture for agentic work |
| `throughput.mean_tok_s` | number | Lifetime mean: `tokens.total` ÷ seconds since `started_at_utc` (idle included) |
| `utilization.percent` | number (0–100) | Share of `window_days` during which the GPU was actively generating. This is the **saturation** figure — how full one person's workload keeps the box |
| `utilization.window_days` | int | Window used for utilization, e.g. 30 |
| `routing.local_percent` | number (0–100) | Token share served locally; sums to ~100 with the overflow percent |
| `routing.api_overflow_percent` | number (0–100) | Token share that overflowed to hosted APIs |
| `top_models[]` | array, max 3 | Top 3 models by lifetime tokens, sorted descending. `model` = bare client-facing tag (same names as `/api/tokens` `by_model`, e.g. `qwen3.8-flash-next@iq4_xs`). `share_percent` is of all tokens |

## What the frontend calculates itself

The backend only supplies raw ingredients; these are computed in the browser from them:

- **Cost per hour** (headline of the Power & energy box) = `power.average_w / 1000 × $0.14`; the lifetime total (`kwh × rate`) moves into that box's breakdown
- **Throughput headline** = `throughput.mean_tok_s` (falls back to `peak_tok_s` until `started_at_utc` is known)
- **Net savings** = `cost.api_cost_saved_usd − power cost`
- **Estimated payback**: with `days = now − started_at_utc`, `daily = net / days`:
  - if `net ≥ setup_cost` → "Paid for itself, net of power" in ~`setup_cost / daily` days
  - otherwise → "~N days to break even" where N = `(setup_cost − net) / daily`, plus % recovered

## Graceful degradation (important)

**Every field is optional.** The site renders `—` placeholders for anything missing and only fills in what it receives, so you can ship this endpoint incrementally (e.g. tokens + routing first, cost/power later) without breaking the page. No auth, no query params needed.
