# uptime-monitor

A Cloudflare Worker that checks HTTP and TCP endpoints from more than one region and sends a Telegram alert when an endpoint goes down. It runs on the Workers free plan.

Status: skeleton. The handlers are empty until the phases of the implementation plan are done.

## How it works

1. A Cron Trigger starts the Worker each minute.
2. The Worker reads the config from the `config` key in KV and selects the monitors that are due.
3. For each region, the Worker calls a `Probe` Durable Object. Each `Probe` object has a location hint for its region, so its checks leave from that region.
4. The Worker sends all results to the `State` Durable Object.
5. `State` counts the failures. It sends a Telegram message when a monitor goes down or recovers.

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
