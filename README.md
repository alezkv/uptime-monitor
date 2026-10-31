# uptime-monitor

A Cloudflare Worker that checks HTTP and TCP endpoints from more than one region and sends a Telegram alert when an endpoint goes down. It runs on the Workers free plan.

Status: the checks, the fan-out to regions, and the Telegram alerts work in the tests. The config has no schema yet. Nothing is deployed.

## How it works

1. A Cron Trigger starts the Worker each minute.
2. The Worker reads the config from the `config` key in KV and selects the monitors that are due.
3. For each region, the Worker calls a `Probe` Durable Object. Each `Probe` object has a location hint for its region, so its checks leave from that region.
4. The Worker sends all results to the `State` Durable Object.
5. `State` counts the failures. It sends a Telegram message when a monitor goes down or recovers.

## Alerts

`State` sends one Telegram message when a monitor goes down, and one when it recovers:

```
🔴 DOWN Authelia (auth.example.com)
weur FRA: status 503, expected 200 (120 ms)
eeur WAW: timeout after 10000 ms
enam EWR: ok (95 ms)
```

- A region is down after `failThreshold` consecutive failures.
- A monitor is down when at least `min(regionQuorum, number of regions)` regions are down.
- If Telegram does not accept a message, `State` keeps the old state. The next check of the monitor sends the message again.
- A failed `Probe` call does not count as a failure of its monitors. After 5 runs in a row with no result from a region, `State` sends one "probe failed" message. It sends one more message when the region works again.
- A monitor that you remove or disable loses its state, with no message.

## Development environment

The Nix flake supplies Node.js 22. Wrangler and Vitest are dev dependencies in `node_modules`.

1. Run `direnv allow`.
2. Run `npm install`.

## Commands

| Command | Result |
|---|---|
| `npm test` | Runs the tests in the local Workers runtime. |
| `npm run typecheck` | Type-checks `src` and `test`. |
| `npm run types` | Generates `worker-configuration.d.ts` again. Run it after you change `wrangler.toml`. |
| `npm run dev` | Starts a local Worker. To start a cron run, open `/__scheduled`. |
| `npm run deploy` | Deploys the Worker. |

## Configuration

The repository has no real list of monitors. `monitors.example.yaml` shows the format. Keep the real list in a file outside the repository.

Secrets go in Cloudflare only:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

A header value of the form `secret:NAME` makes the Worker read `env.NAME`. Set each such secret with `wrangler secret put NAME`.

## Local test run

1. Convert the YAML to JSON: `nix shell nixpkgs#yq-go -c yq -o=json -I=0 . monitors.example.yaml > /tmp/config.json`.
2. Load it into local KV: `npx wrangler kv key put --binding CONFIG config --path /tmp/config.json --local`.
3. Start the Worker: `npm run dev`.
4. Start a cron run: `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.
5. Read the line that starts with `{"minute"` in the Wrangler output. It has one result for each monitor and region.

Local Wrangler ignores location hints, so all regions show the same colo.

## Known behavior

- Authelia forward-auth returns `401` to a Worker `fetch()`, but `302` to `curl`.
- `tcp: { tls: true }` checks the certificate. A self-signed certificate fails.
- A Worker cannot open TCP to port 25 or to a Cloudflare IP address, and it has no UDP.
