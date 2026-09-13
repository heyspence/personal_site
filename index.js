// Live local-token counter for the inference console in index.html.
// The public endpoint is cached server-side, so normal polling follows that
// cache window. Chat requests temporarily enable faster reconciliation polls
// so visitors can see their activity land in the lifetime total.

const TOKENS_API_URL = "https://llm.spencerheywood.com/api/tokens";
const POLL_INTERVAL_MS = 15000;
const ACTIVE_SYNC_INTERVAL_MS = 1500;
const TOKEN_REQUEST_TIMEOUT_MS = 8000;
const CHAT_SYNC_TIMEOUT_MS = 45000;

// The inflight gauge file is rewritten on the LLM box (user service
// llm-inflight) and served from this same origin; nginx sends a 20-minute
// cache hint for static paths, so each poll busts it with a fresh timestamp.
const INFLIGHT_API_URL = "/inflight.json";
const INFLIGHT_POLL_INTERVAL_MS = 5000;
const INFLIGHT_REQUEST_TIMEOUT_MS = 8000;

// Only model tags served by Spencer's own hardware contribute to this total.
// Rotate this list when the local model lineup changes (tags are the bare
// client-facing names from agentgateway virtualModels). Unknown tags read 0.
const LOCAL_MODEL_TAGS = [
    "qwen3.8-flash-next@iq4_xs",
    "qwen3.8-27b",
    "gemma-4-12b-qat",
    "default"
];

function localTokenTotal(data) {
    if (!data || typeof data.by_model !== "object" || data.by_model === null) {
        throw new Error("Invalid token response");
    }

    const total = LOCAL_MODEL_TAGS.reduce((sum, tag) => {
        const value = Number(data.by_model[tag]) || 0;
        return sum + value;
    }, 0);

    if (!Number.isFinite(total) || total < 0) {
        throw new Error("Invalid local token total");
    }

    return Math.round(total);
}

(function initLabTelemetry() {
    const countEl = document.getElementById("local-token-count");
    if (!countEl) return;

    const accessibleCountEl = document.getElementById("local-token-count-a11y");
    const statusEl = document.getElementById("telemetry-updated");
    const deltaEl = document.getElementById("telemetry-delta");
    const consoleEl = countEl.closest(".lab-console") || countEl.closest(".lab-telemetry");

    let lastValue = null;
    let lastServerValue = null;
    let pendingDisplayFloor = null;
    let shownFormatted = "";
    let latestPayloadTimestamp = 0;
    let lastPayload = null;
    let pollTimer = null;
    let pollInFlight = false;
    let chatBaseline = null;
    let syncState = null;
    let deltaHideTimer = null;

    function formatNumber(value) {
        return value.toLocaleString("en-US");
    }

    function updateCount(value) {
        const formatted = formatNumber(value);
        const comparable = shownFormatted.length > 0 && shownFormatted.length === formatted.length;
        const fragment = document.createDocumentFragment();

        for (let index = 0; index < formatted.length; index += 1) {
            const character = formatted[index];
            const span = document.createElement("span");
            span.className = "telemetry-digit";
            span.textContent = character;
            span.setAttribute("aria-hidden", "true");

            if (comparable && /[0-9]/.test(character) && shownFormatted[index] !== character) {
                span.classList.add("is-changed");
            }

            fragment.appendChild(span);
        }

        countEl.replaceChildren(fragment);
        if (accessibleCountEl) {
            accessibleCountEl.textContent = `${formatted} local AI tokens processed`;
        }
        shownFormatted = formatted;
    }

    function payloadStatus(data) {
        const updatedAt = data && data.updated_at_utc ? new Date(data.updated_at_utc) : null;
        if (!updatedAt || Number.isNaN(updatedAt.getTime())) return "Counter live";

        return `Updated ${updatedAt.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit"
        })}`;
    }

    function updateStatus() {
        if (!statusEl) return;

        if (consoleEl && consoleEl.classList.contains("is-generating")) {
            statusEl.textContent = "Generating on the local GPU…";
        } else if (syncState) {
            statusEl.textContent = syncState.timedOut
                ? "Answer counted · gateway aggregate pending…"
                : "Syncing your tokens to the gateway total…";
        } else {
            statusEl.textContent = payloadStatus(lastPayload);
        }
    }

    function showDelta(delta, state = "verified") {
        if (!deltaEl || delta <= 0) return;

        window.clearTimeout(deltaHideTimer);
        deltaEl.textContent = state === "syncing"
            ? `+${formatNumber(delta)} · syncing`
            : "Counter refreshed";
        deltaEl.hidden = false;
        deltaHideTimer = window.setTimeout(() => {
            deltaEl.hidden = true;
        }, 9000);
    }

    function finishSync(value) {
        if (!syncState || !Number.isFinite(syncState.baseline)) return false;

        const hasTarget = Number.isFinite(syncState.target);
        const hasReachedAggregate = hasTarget
            ? value >= syncState.target
            : value > syncState.baseline;
        if (!hasReachedAggregate) return false;

        const expectedUsage = syncState.usage;
        const delta = expectedUsage || value - syncState.baseline;
        syncState = null;
        if (consoleEl) consoleEl.classList.remove("is-syncing");
        showDelta(delta);
        updateStatus();

        document.dispatchEvent(new CustomEvent("lab-telemetry-synced", {
            detail: { delta, expectedUsage }
        }));
        return true;
    }

    function render(data) {
        const payloadTimestamp = data.updated_at_utc ? Date.parse(data.updated_at_utc) : 0;
        if (Number.isFinite(payloadTimestamp) && payloadTimestamp > 0) {
            if (payloadTimestamp < latestPayloadTimestamp) return;
            latestPayloadTimestamp = payloadTimestamp;
        }

        const value = localTokenTotal(data);
        lastServerValue = value;
        lastPayload = data;

        if (pendingDisplayFloor !== null && value >= pendingDisplayFloor) {
            pendingDisplayFloor = null;
        }

        const holdOptimisticValue = pendingDisplayFloor !== null && value < pendingDisplayFloor;
        if (!holdOptimisticValue && value !== lastValue) {
            updateCount(value);
            lastValue = value;
        }

        if (consoleEl) consoleEl.classList.remove("is-offline");
        finishSync(value);
        updateStatus();
    }

    async function poll() {
        if (pollInFlight || document.hidden) return;

        pollInFlight = true;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(TOKENS_API_URL, {
                cache: "no-store",
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            render(await response.json());
        } catch (error) {
            console.warn("[lab-telemetry] token poll failed:", error.message);
            if (consoleEl) consoleEl.classList.add("is-offline");
            if (statusEl) {
                statusEl.textContent = lastValue === null
                    ? "Counter unavailable · retrying"
                    : "Counter reconnecting…";
            }
        } finally {
            window.clearTimeout(timeout);
            pollInFlight = false;
        }
    }

    function expireSyncIfNeeded() {
        if (!syncState || syncState.timedOut || Date.now() - syncState.startedAt < CHAT_SYNC_TIMEOUT_MS) return;

        syncState.timedOut = true;
        if (consoleEl) consoleEl.classList.remove("is-syncing");
        updateStatus();
        document.dispatchEvent(new CustomEvent("lab-telemetry-sync-timeout", {
            detail: { expectedUsage: syncState.usage }
        }));
    }

    function schedulePoll(delay) {
        window.clearTimeout(pollTimer);
        if (document.hidden) return;
        pollTimer = window.setTimeout(runScheduledPoll, delay);
    }

    async function runScheduledPoll() {
        await poll();
        expireSyncIfNeeded();
        schedulePoll(syncState && !syncState.timedOut ? ACTIVE_SYNC_INTERVAL_MS : POLL_INTERVAL_MS);
    }

    document.addEventListener("lab-chat-start", () => {
        chatBaseline = lastValue;
        if (consoleEl) {
            consoleEl.classList.remove("is-syncing");
            consoleEl.classList.add("is-generating");
        }
        syncState = null;
        updateStatus();
    });

    document.addEventListener("lab-chat-complete", (event) => {
        const usage = Number(event.detail && event.detail.totalTokens) || null;
        const baseline = Number.isFinite(chatBaseline) ? chatBaseline : lastValue;
        chatBaseline = null;
        const target = usage && Number.isFinite(baseline) ? baseline + usage : null;
        syncState = {
            baseline,
            target,
            usage,
            startedAt: Date.now(),
            timedOut: false
        };

        const aggregateAlreadyIncludesTarget = target !== null
            && lastServerValue !== null
            && lastServerValue >= target;

        if (target !== null && !aggregateAlreadyIncludesTarget) {
            pendingDisplayFloor = Math.max(pendingDisplayFloor || 0, target);
            if (lastValue === null || target > lastValue) {
                updateCount(target);
                lastValue = target;
            }
            showDelta(usage, "syncing");
        }

        if (consoleEl) {
            consoleEl.classList.remove("is-generating");
            consoleEl.classList.add("is-syncing");
        }

        if (lastServerValue !== null && finishSync(lastServerValue)) {
            schedulePoll(POLL_INTERVAL_MS);
        } else {
            updateStatus();
            schedulePoll(0);
        }
    });

    document.addEventListener("lab-chat-error", () => {
        chatBaseline = null;
        syncState = null;
        if (consoleEl) consoleEl.classList.remove("is-generating", "is-syncing");
        updateStatus();
        schedulePoll(0);
    });

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            window.clearTimeout(pollTimer);
        } else {
            schedulePoll(0);
        }
    });

    runScheduledPoll();
})();

// Live "active streams" gauge for the inference console (visitor-facing
// wording; internally this is the in-flight generation count).
// A loop on the LLM box rewrites /inflight.json with the number of established
// connections to the LM Studio backend — the same figure `llm-limit` prints —
// plus the qwen-limited gate's limit_conn cap, rendered as one dot per slot.
// Direct (unlimited) routes for other models count too, so a full row does not
// by itself mean the gate is rejecting anything.

(function initInflightGauge() {
    const indicatorEl = document.getElementById("inflight-indicator");
    const dotsEl = document.getElementById("inflight-dots");
    const textEl = document.getElementById("inflight-text");
    const a11yEl = document.getElementById("inflight-a11y");
    if (!indicatorEl || !dotsEl || !textEl) return;

    let pollTimer = null;
    let pollInFlight = false;
    let renderedKey = "";
    let failCount = 0;

    function renderDots(max) {
        while (dotsEl.children.length < max) dotsEl.appendChild(document.createElement("i"));
        while (dotsEl.children.length > max) dotsEl.lastChild.remove();
    }

    function render(data) {
        const inflight = Number(data && data.in_flight);
        const max = Number(data && data.max_concurrent);
        if (!Number.isInteger(inflight) || inflight < 0) throw new Error("Invalid in-flight payload");
        const hasMax = Number.isInteger(max) && max > 0;

        failCount = 0;
        indicatorEl.classList.remove("is-offline");

        if (hasMax) renderDots(max);
        for (let index = 0; index < dotsEl.children.length; index += 1) {
            dotsEl.children[index].classList.toggle("is-active", index < inflight);
        }
        indicatorEl.classList.toggle("is-full", hasMax && inflight >= max);

        const key = `ok|${inflight}|${hasMax ? max : "-"}`;
        if (key === renderedKey) return;
        renderedKey = key;

        textEl.textContent = hasMax ? `${inflight} / ${max} active streams` : `${inflight} active streams`;
        if (a11yEl) {
            a11yEl.textContent = hasMax
                ? `${inflight} of ${max} active streams`
                : `${inflight} active streams`;
        }
    }

    function markOffline() {
        failCount += 1;
        // Tolerate the first miss (deploy window, network blip) before dimming.
        if (failCount < 2 || renderedKey === "offline") return;
        renderedKey = "offline";
        indicatorEl.classList.add("is-offline");
        textEl.textContent = "\u2013 active streams";
        if (a11yEl) a11yEl.textContent = "Live activity unavailable";
    }

    async function poll() {
        if (pollInFlight || document.hidden) return;

        pollInFlight = true;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), INFLIGHT_REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(`${INFLIGHT_API_URL}?ts=${Date.now()}`, {
                cache: "no-store",
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            render(await response.json());
        } catch (error) {
            console.warn("[inflight] poll failed:", error.message);
            markOffline();
        } finally {
            window.clearTimeout(timeout);
            pollInFlight = false;
        }
    }

    function schedulePoll(delay) {
        window.clearTimeout(pollTimer);
        if (document.hidden) return;
        pollTimer = window.setTimeout(runScheduledPoll, delay);
    }

    async function runScheduledPoll() {
        await poll();
        schedulePoll(INFLIGHT_POLL_INTERVAL_MS);
    }

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            window.clearTimeout(pollTimer);
        } else {
            schedulePoll(0);
        }
    });

    runScheduledPoll();
})();

// ============================ LAB STATS / SYSTEM ECONOMICS ============================
// Economics panel under the live counter: avoided API spend, payback, power cost,
// utilization, and the local/overflow split. Fed by /api/usage — a slower-changing
// aggregate than /api/tokens, so it polls on a longer window.
//
// The payload is designed to be partial: every field is optional and missing values
// keep their "\u2014" placeholder, so the panel degrades gracefully while the backend
// catches up. Derived numbers (electricity cost, net savings, payback) are computed
// here in the browser from the raw ingredients.

const USAGE_API_URL = "https://llm.spencerheywood.com/api/usage";
const USAGE_POLL_INTERVAL_MS = 60000;
const USAGE_REQUEST_TIMEOUT_MS = 8000;
const FALLBACK_SETUP_COST_USD = 14000;
const POWER_RATE_USD_PER_KWH = 0.14; // household rate used for the power cost estimate

(function initLabStats() {
    const statsEl = document.getElementById("lab-stats");
    if (!statsEl) return;

    const $ = (id) => document.getElementById(id);

    const updatedEl = $("stats-updated");
    const costSavedEl = $("stat-cost-saved");
    const costSavedSubEl = $("stat-cost-saved-sub");
    const paybackEl = $("stat-payback");
    const paybackSubEl = $("stat-payback-sub");
    const utilEl = $("stat-util");
    const utilSubEl = $("stat-util-sub");
    const localPctEl = $("stat-local-pct");
    const overflowAmtEl = $("stat-overflow-amt");
    const overflowShareEl = $("stat-overflow-share");
    const tokensTotalEl = $("stat-tokens-total");
    const ioBarEl = $("stat-io-bar");
    const ioInputEl = $("stat-io-input");
    const ioOutputEl = $("stat-io-output");
    const ioLabelEl = $("stat-io-label");
    const requestsEl = $("stat-requests");
    const overflowTokensEl = $("stat-overflow-tokens");
    const powerCostEl = $("stat-power-cost");
    const energyLineEl = $("stat-energy-line");
    const powerWEl = $("stat-power-w");
    const powerLifetimeEl = $("stat-power-lifetime");
    const netLineEl = $("stat-net-line");
    const tpsPeakEl = $("stat-tps-peak");
    const tpsPeakInnerEl = $("stat-tps-peak-inner");
    const tpsAvgEl = $("stat-tps-avg");
    const tpsMeanEl = $("stat-tps-mean");
    const topModelEl = $("stat-top-model");
    const modelRows = [0, 1, 2].map((index) => ({
        row: $(`stat-model-${index}-row`),
        name: $(`stat-model-${index}-name`),
        bar: $(`stat-model-${index}-bar`),
        tokens: $(`stat-model-${index}-tokens`),
        pct: $(`stat-model-${index}-pct`)
    }));

    // The four breakdowns expand and collapse as one group: opening any one
    // reveals all of them so the visitor can compare without clicking through.
    const detailEls = Array.from(statsEl.querySelectorAll(".stat-details"));
    detailEls.forEach((detail) => {
        detail.addEventListener("toggle", () => {
            detailEls.forEach((other) => {
                if (other !== detail && other.open !== detail.open) other.open = detail.open;
            });
        });
    });

    let pollTimer = null;
    let pollInFlight = false;
    let lastKey = "";
    let failCount = 0;

    function num(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }

    function trimNum(value) {
        const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1);
        return text.replace(/\.0$/, "");
    }

    function formatCompact(value) {
        if (value >= 1e9) return trimNum(value / 1e9) + "B";
        if (value >= 1e6) return trimNum(value / 1e6) + "M";
        if (value >= 1e3) return trimNum(value / 1e3) + "K";
        return String(Math.round(value));
    }

    function formatUsd(value) {
        return "$" + Math.round(value).toLocaleString("en-US");
    }

    // Sub-dollar figures (cost per hour of generating) need cents to be legible.
    function formatUsdFine(value) {
        if (value >= 1) return formatUsd(value);
        return "$" + value.toFixed(2);
    }

    function formatTokS(value) {
        return value >= 1000 ? String(Math.round(value)) : trimNum(value);
    }

    // Payback at real per-model rates lands in the months-to-years range; pick
    // a readable unit — days under ~3 months, then months, then years.
    function formatDays(days) {
        if (days > 730) return `~${Math.round(days / 365.25)} yrs`;
        if (days > 90) return `~${Math.round(days / 30.44)} mo`;
        return `~${days} days`;
    }

    function setText(el, text) {
        if (el && text != null) el.textContent = text;
    }

    function setBar(el, percent) {
        if (!el) return;
        const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
        el.style.width = `${clamped}%`;
    }

    function payloadStatus(data) {
        const updatedAt = data && data.updated_at_utc ? new Date(data.updated_at_utc) : null;
        if (!updatedAt || Number.isNaN(updatedAt.getTime())) return "Aggregates live";

        return `Updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    }

    function render(data) {
        const lifetime = data.lifetime || {};
        const cost = data.cost || {};
        const power = data.power || {};
        const energy = data.energy || {};
        const throughput = data.throughput || {};
        const utilization = data.utilization || {};
        const routing = data.routing || {};
        const tokens = lifetime.tokens || {};

        const startedAt = Date.parse(lifetime.started_at_utc) || 0;
        const daysInService = startedAt > 0 && Date.now() >= startedAt
            ? (Date.now() - startedAt) / 86400000
            : null;

        // Lifetime tokens, input/output split, request count.
        const totalTokens = num(tokens.total);
        if (totalTokens != null) setText(tokensTotalEl, formatCompact(totalTokens));

        const inputTokens = num(tokens.input);
        const outputTokens = num(tokens.output);
        const tokenSum = (inputTokens || 0) + (outputTokens || 0);
        if (inputTokens != null && outputTokens != null && tokenSum > 0) {
            const inPct = (inputTokens / tokenSum) * 100;
            setBar(ioInputEl, inPct);
            setBar(ioOutputEl, 100 - inPct);
            setText(ioLabelEl, `${Math.round(inPct)}% input \u00b7 ${formatCompact(inputTokens)} \u2014 ${Math.round(100 - inPct)}% output \u00b7 ${formatCompact(outputTokens)}`);
            if (ioBarEl) {
                ioBarEl.setAttribute("aria-label", `Input ${Math.round(inPct)} percent, output ${Math.round(100 - inPct)} percent of lifetime tokens`);
            }
        }

        const requests = num(lifetime.requests);
        if (requests != null) setText(requestsEl, formatCompact(requests));

        const overflowTokens = num(lifetime.api_overflow_tokens);
        if (overflowTokens != null) setText(overflowTokensEl, formatCompact(overflowTokens));

        // Electricity: frontend calc = lifetime kWh \u00d7 house rate.
        const kwh = num(energy.kwh_lifetime);
        const powerCost = kwh != null ? kwh * POWER_RATE_USD_PER_KWH : null;
        if (kwh != null) {
            setText(energyLineEl, `${Math.round(kwh).toLocaleString("en-US")} kWh lifetime \u00b7 $${POWER_RATE_USD_PER_KWH.toFixed(2)}/kWh`);
        }
        const avgW = num(power.average_w);
        if (avgW != null) setText(powerWEl, `~${Math.round(avgW)}W average draw at 3 concurrent streams`);
        // Headline is the cost per generating hour at the measured draw; the
        // lifetime total moves into the breakdown body.
        const costPerHour = avgW != null ? (avgW / 1000) * POWER_RATE_USD_PER_KWH : null;
        if (costPerHour != null) setText(powerCostEl, formatUsdFine(costPerHour));
        if (powerCost != null) setText(powerLifetimeEl, `Lifetime cost so far: ${formatUsd(powerCost)}`);

        // Avoided hosted spend.
        const saved = num(cost.api_cost_saved_usd);
        if (saved != null) setText(costSavedEl, formatUsd(saved));
        const refNote = typeof cost.reference_note === "string" && cost.reference_note
            ? cost.reference_note
            : null;
        const refModel = typeof cost.reference_model === "string" && cost.reference_model
            ? cost.reference_model
            : null;
        setText(costSavedSubEl, refNote || (refModel
            ? `All tokens vs ${refModel} list pricing`
            : "All tokens vs hosted list pricing"));

        // Net savings after power (frontend calc).
        if (saved != null && powerCost != null) {
            const net = saved - powerCost;
            setText(netLineEl, net > 0
                ? `Net of power: ${formatUsd(net)} saved`
                : "Power cost exceeds avoided spend so far");
        }

        // Estimated payback (frontend calc), net of power.
        const setupCost = num(cost.setup_cost_usd);
        const budget = setupCost != null ? setupCost : FALLBACK_SETUP_COST_USD;
        const netSavings = saved != null && powerCost != null
            ? saved - powerCost
            : saved;
        if (netSavings != null && netSavings > 0 && daysInService != null && daysInService >= 1) {
            const dailySavings = netSavings / daysInService;
            if (dailySavings > 0) {
                if (netSavings >= budget) {
                    setText(paybackEl, formatDays(Math.max(1, Math.round(budget / dailySavings))));
                    setText(paybackSubEl, "Paid for itself, net of power");
                } else {
                    const remaining = Math.ceil((budget - netSavings) / dailySavings);
                    const recovered = Math.min(99, Math.round((netSavings / budget) * 100));
                    setText(paybackEl, formatDays(remaining));
                    setText(paybackSubEl, `To break even \u00b7 ${recovered}% of the build recovered`);
                }
            }
        }

        // Utilization (saturation) over the gateway's window.
        const utilPct = num(utilization.percent);
        if (utilPct != null) {
            setText(utilEl, `${trimNum(Math.min(utilPct, 100))}%`);
            const windowDays = num(utilization.window_days);
            if (windowDays != null) {
                setText(utilSubEl, `Busy time \u00b7 last ${Math.round(windowDays)} days`);
            }
        }

        // Local vs API overflow.
        const localPct = num(routing.local_percent);
        if (localPct != null) {
            setText(localPctEl, `${trimNum(localPct)}%`);
            if (overflowTokens != null) {
                const overflowPct = num(routing.api_overflow_percent);
                const share = trimNum(overflowPct != null ? overflowPct : Math.max(0, 100 - localPct));
                setText(overflowAmtEl, formatCompact(overflowTokens));
                setText(overflowShareEl, `${share}%`);
            }
        }

        // Throughput — the headline is lifetime mean, the sustained picture of
        // what one person's workload actually moves; single-stream peak decode
        // stays in the breakdown for reference.
        const peak = num(throughput.peak_tok_s);
        if (peak != null) setText(tpsPeakInnerEl, formatTokS(peak));
        const avg24h = num(throughput.avg_24h_tok_s);
        if (avg24h != null) setText(tpsAvgEl, formatTokS(avg24h));
        const mean = num(throughput.mean_tok_s);
        if (mean != null) setText(tpsMeanEl, formatTokS(mean));
        // Fallback to peak keeps the box filled before started_at is known.
        const headlineTps = mean != null ? mean : peak;
        if (headlineTps != null) setText(tpsPeakEl, `${formatTokS(headlineTps)}/s`);

        // Top models.
        const models = Array.isArray(data.top_models) ? data.top_models.slice(0, 3) : [];
        modelRows.forEach((entry, index) => {
            const model = models[index];
            if (!model) {
                if (entry.row) entry.row.hidden = true;
                return;
            }
            if (entry.row) entry.row.hidden = false;
            setText(entry.name, typeof model.model === "string" && model.model ? model.model : "unknown");
            const modelTokens = num(model.tokens);
            if (modelTokens != null) {
                setText(entry.tokens, formatCompact(modelTokens));
                setBar(entry.bar, num(model.share_percent));
            }
            const share = num(model.share_percent);
            if (share != null) setText(entry.pct, `${trimNum(share)}%`);
        });
        if (models[0] && typeof models[0].model === "string") setText(topModelEl, models[0].model);
    }

    function markOffline() {
        failCount += 1;
        // Tolerate the first miss (deploy window, network blip) before dimming.
        if (failCount < 2) return;
        statsEl.classList.add("is-offline");
        setText(updatedEl, "Gateway stats unavailable \u00b7 retrying");
    }

    async function poll() {
        if (pollInFlight || document.hidden) return;

        pollInFlight = true;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), USAGE_REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(USAGE_API_URL, {
                cache: "no-store",
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            failCount = 0;
            statsEl.classList.remove("is-offline");
            setText(updatedEl, payloadStatus(data));

            // The server caches the aggregate; skip the re-render when nothing moved.
            const key = data && data.updated_at_utc ? String(data.updated_at_utc) : "live";
            if (key !== lastKey) {
                lastKey = key;
                render(data);
            }
        } catch (error) {
            console.warn("[lab-stats] usage poll failed:", error.message);
            markOffline();
        } finally {
            window.clearTimeout(timeout);
            pollInFlight = false;
        }
    }

    function schedulePoll(delay) {
        window.clearTimeout(pollTimer);
        if (document.hidden) return;
        pollTimer = window.setTimeout(runScheduledPoll, delay);
    }

    async function runScheduledPoll() {
        await poll();
        schedulePoll(USAGE_POLL_INTERVAL_MS);
    }

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            window.clearTimeout(pollTimer);
        } else {
            schedulePoll(0);
        }
    });

    runScheduledPoll();
})();
