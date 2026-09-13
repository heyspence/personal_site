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
