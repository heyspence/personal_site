# chat-proxy — Lab Chat gateway proxy

Keeps the AgentGateway API key out of the public site. `lab-chat.js` (served to
every visitor) no longer contains a key; it calls same-origin paths under
`/chat-proxy/`, and this zero-dependency Node service injects the key
server-side before forwarding to:

- `/v1/chat/completions` → `https://llm.spencerheywood.com/v1/chat/completions`
- `/mcp*`               → `https://mcp.spencerheywood.com/mcp/` (email tool)

Requires Node 18+ on the box. No npm dependencies.

## Setup (on spencerheywood.com, the OptiPlex server)

The code deploys with the normal `git pull`. The key does not — `.env` is
gitignored, so it has to be placed on the box once:

```sh
cd /home/spencerheywood/Documents/personal_site/server
# create .env containing:  LAB_CHAT_API_KEY=sk-...   (the new gateway key)
chmod 600 .env
```

Run a one-shot test from the box itself before wiring up nginx:

```sh
node chat-proxy.mjs &      # listens on 127.0.0.1:8791
curl -s http://127.0.0.1:8791/healthz
curl -s -X POST http://127.0.0.1:8791/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"default","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```

### systemd unit — `/etc/systemd/system/chat-proxy.service`

```ini
[Unit]
Description=Lab chat gateway proxy (keeps API key out of the public site)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/spencerheywood/Documents/personal_site/server
ExecStart=/usr/bin/env node /home/spencerheywood/Documents/personal_site/server/chat-proxy.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now chat-proxy
journalctl -u chat-proxy -f   # watch the first request come through
```

### nginx — in the `spencerheywood.com` server block

The trailing slash on `proxy_pass` is what strips `/chat-proxy`, so the proxy
sees plain `/v1/...` and `/mcp/...` paths:

```nginx
location /chat-proxy/ {
    proxy_pass http://127.0.0.1:8791/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 120s;   # local models can be slow to first token
    proxy_send_timeout 60s;
}
```

Then `sudo nginx -t && sudo systemctl reload nginx` and verify from anywhere:

```sh
curl -s https://spencerheywood.com/chat-proxy/healthz
```

## Notes / trade-offs

- **No rate limiting or per-visitor auth.** This is the same trust model as
  before — anonymous visitors were always able to talk to the local model via
  the widget, and they can still do so. The only thing that changed is that the
  key itself is no longer visible in page source (or usable directly against
  `llm.`/`mcp.spencerheywood.com`). If you want anonymous access locked down
  later, add a shared secret check here — but visitors would then need it too.
- **The old key (`[REDACTED]`) was public.** It has been removed
  from `lab-chat.js`, but it still exists in git history and was exposed to the
  world, so make sure it is revoked in AgentGateway — that's what makes the new
  key an actual fix rather than a cosmetic one.
- The proxy only forwards the two chat paths; every other path is a 404, so it
  can't be used as a tunnel to `/api/usage`, `/inflight.json`, etc.
