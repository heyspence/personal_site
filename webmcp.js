// WebMCP tools for this page (W3C spec: https://webmachinelearning.github.io/webmcp/).
// Registers structured tools on document.modelContext so browser AI assistants that
// speak WebMCP (Chrome 149+ via the enable-webmcp-testing flag or origin trial, ChatGPT
// Desktop) can use this site without scraping the DOM. This is the opposite direction
// from lab-chat.js — that file makes the page an MCP *client* of the AgentGateway;
// here the page itself acts as a WebMCP tool server for whatever assistant opens it.
// vendor/webmcp-polyfill.js (Google, Apache-2.0) provides document.modelContext in
// browsers without native support so inspector extensions can discover these tools too.

(function initWebMcp() {
    const modelContext = document.modelContext;
    if (!modelContext || typeof modelContext.registerTool !== "function") return;

    // Same public, CORS-open, no-auth endpoint the "Live Lab Stats" panel polls
    // (see usage-api-schema.md) — every field is optional and degrades gracefully.
    const STATS_API_URL = "https://llm.spencerheywood.com/api/usage";
    const STATS_TIMEOUT_MS = 8000;

    // Same-origin chat-proxy path the Lab Chat widget uses: nginx forwards it to the
    // LLM gateway with the key injected server-side, so no credentials ship in this file.
    const CHAT_COMPLETIONS_URL = "/chat-proxy/v1/chat/completions";
    const ASK_MODEL_TIMEOUT_MS = 60000;
    // The local GPU can be saturated — mirror the widget's single busy retry.
    const BUSY_RETRY_DELAY_MS = 2000;
    const MAX_QUESTION_LENGTH = 600; // matches the lab-chat input cap

    const ASK_SYSTEM_PROMPT = "You are 'Lab Chat', an assistant on Spencer Heywood's personal website (spencerheywood.com), powered by a model running on his own self-hosted hardware. Answer warmly and concisely in 2-6 sentences, grounded in what the site says about him. If something is not covered or you don't know it, say so plainly instead of guessing.";

    // Maps tool input values to the h2 anchors used by the masthead nav in index.html.
    const SECTION_TARGETS = {
        "live-stats": ["lab-stats-title", "Live Lab Stats"],
        "focus": ["focus-title", "Transformation Focus"],
        "experience": ["experience-title", "Professional Experience"],
        "delivery-process": ["ai-title", "End-to-End Delivery"],
        "ai-lab": ["lab-title", "AI Systems Lab"],
        "projects": ["projects-title", "Selected Projects"],
        "capabilities": ["capabilities-title", "Technical Capabilities"],
        "education": ["education-title", "Education"],
        "contact": ["contact-title", "Contact"]
    };

    async function fetchLabStats() {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), STATS_TIMEOUT_MS);
        try {
            const response = await fetch(STATS_API_URL, { cache: "no-store", signal: controller.signal });
            if (!response.ok) throw new Error(`Lab stats request failed (HTTP ${response.status})`);
            return await response.json();
        } catch (error) {
            if (error.name === "AbortError") throw new Error("Lab stats request timed out");
            throw error;
        } finally {
            window.clearTimeout(timeout);
        }
    }

    async function askLocalModel(args) {
        const question = String((args && args.question) || "").trim().slice(0, MAX_QUESTION_LENGTH);
        if (!question) throw new Error("A 'question' is required");

        const payload = JSON.stringify({
            model: "default",
            messages: [
                { role: "system", content: ASK_SYSTEM_PROMPT },
                { role: "user", content: question }
            ],
            temperature: 0.4,
            max_tokens: 512
        });

        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), ASK_MODEL_TIMEOUT_MS);
        let data;
        try {
            for (let attempt = 0; ; attempt++) {
                const response = await fetch(CHAT_COMPLETIONS_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    signal: controller.signal,
                    body: payload
                });

                if (response.ok) {
                    data = await response.json();
                    break;
                }
                if (response.status === 429 && attempt === 0) {
                    await new Promise((resolve) => window.setTimeout(resolve, BUSY_RETRY_DELAY_MS));
                    continue;
                }
                throw new Error(`The local model is unreachable (HTTP ${response.status})`);
            }
        } catch (error) {
            if (error.name === "AbortError") throw new Error("The local model took too long to answer");
            throw error;
        } finally {
            window.clearTimeout(timeout);
        }

        const answer = data && data.choices && data.choices[0]
            ? String(data.choices[0].message && data.choices[0].message.content || "").trim()
            : "";
        if (!answer) throw new Error("The local model returned an empty answer");
        return answer;
    }

    function scrollToSection(args) {
        const section = args && args.section;
        const target = SECTION_TARGETS[section];
        if (!target) {
            throw new Error(`Unknown section "${section}". Valid values: ${Object.keys(SECTION_TARGETS).join(", ")}`);
        }

        const heading = document.getElementById(target[0]);
        if (!heading) throw new Error(`The page no longer has a section anchored at #${target[0]}`);
        heading.scrollIntoView({ behavior: "smooth", block: "start" });
        return `Scrolled the page to "${target[1]}".`;
    }

    const tools = [
        {
            name: "get_live_lab_stats",
            description: "Fetch live stats for Spencer's self-hosted AI lab straight from his LLM gateway: decode throughput in tokens/sec (mean aggregate across concurrent streams, peak single-stream, 24-hour average), lifetime token and request totals, build cost vs hosted-API spend avoided, wall power draw, energy used, GPU utilization, the local-vs-api-overflow routing split, and the top serving models. Use this whenever asked about the lab's performance or any of those numbers — never quote them from memory.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: fetchLabStats
        },
        {
            name: "ask_local_model",
            description: `Ask a question to the LLM running on Spencer's own hardware (served through his AgentGateway) and return its plain-text answer. Good for questions about his experience, projects, or AI lab that benefit from the model's own voice. Use sparingly — local generation takes several seconds.`,
            inputSchema: {
                type: "object",
                properties: {
                    question: { type: "string", description: `The question to ask the local model (max ${MAX_QUESTION_LENGTH} characters).` }
                },
                required: ["question"],
                additionalProperties: false
            },
            execute: askLocalModel
        },
        {
            name: "navigate_to_section",
            description: "Scroll this page to one of its main sections so the user can see a specific part of Spencer's site.",
            inputSchema: {
                type: "object",
                properties: {
                    section: { type: "string", enum: Object.keys(SECTION_TARGETS), description: "Which section to show." }
                },
                required: ["section"],
                additionalProperties: false
            },
            execute: scrollToSection
        }
    ];

    const registered = [];
    for (const tool of tools) {
        try {
            modelContext.registerTool(tool);
            registered.push(tool.name);
        } catch (error) {
            console.warn(`[webmcp] failed to register ${tool.name}:`, error.message);
        }
    }

    if (registered.length > 0) {
        console.info(`[webmcp] exposed tools: ${registered.join(", ")}`);
    }
})();
