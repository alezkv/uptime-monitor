# uptime-monitor

A Cloudflare Worker that checks HTTP and TCP endpoints from more than one region and sends a Telegram alert when an endpoint goes down. It runs on the Workers free plan.

Status: the code for phases 1 to 5 is complete, and the tests pass. The Worker runs on Cloudflare since 2026-11-01, and a test alert reached Telegram.

## How it works

1. A Cron Trigger starts the Worker each minute.
2. The Worker reads the config from the `config` key in KV and selects the monitors that are due.
3. For each region, the Worker calls a `Probe` Durable Object. Each `Probe` object has a location hint for its region, so its checks leave from that region.
4. The Worker sends all results to the `State` Durable Object.
5. `State` counts the failures. It sends a Telegram message when a monitor goes down or recovers.
6. The Worker sends a heartbeat ping to the `dms` Worker. See [Heartbeat](#heartbeat).

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

## Heartbeat

After each complete run, the cron handler sends `POST /ping/uptime-monitor` to the `dms` Worker of [dead-mans-switch](https://github.com/alezkv/dead-mans-switch). If `dms` gets no ping in time, it sends a Telegram alert. Thus you also get an alert when this monitor stops.

- The ping goes through the service binding `DMS` in `wrangler.toml`. A Worker cannot fetch another Worker on `workers.dev` by URL.
- The ping carries `Authorization: Bearer <DMS_PING_TOKEN>`. The token is the `PING_TOKEN` secret of `dms`.
- The handler sends the ping only after `State.record()` returns, or when no monitor is due. A run that stops early sends no ping. For example, a config that is not valid stops the run.
- If the binding or `DMS_PING_TOKEN` is missing, the Worker sends no ping. The tests and `npm run dev` work with no `dms` Worker.
- A failed ping goes to the log as `heartbeat failed`. It does not stop the run, and the alerts go out before the ping.
- The `CHECKS` secret of `dms` must have the check `uptime-monitor`. A `timeout` of 1200 seconds gives a margin for a late cron run after a deploy.

Cost on the free plan: one more subrequest for each run, and 1,440 `dms` requests and Durable Object requests each day.

## Development environment

The Nix flake supplies Node.js 22. The config script needs Node.js 22.18 or later, because it runs a `.ts` file with no build step. Wrangler and Vitest are dev dependencies in `node_modules`.

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
| `npm run config:check -- <file>` | Validates a monitors YAML file. |
| `npm run config:push -- <file>` | Validates the file, then writes it to the `config` key in KV. Add `--local` to write to the local KV of `npm run dev`. |

## Configuration

The repository has no real list of monitors. `monitors.example.yaml` shows the format. Keep the real list in a file outside the repository.

The schema is in `src/config.ts`. It rejects an unknown field, so a misspelled field name gives an error and is not ignored. The cron handler validates the config on each run. If the config is not valid, the handler logs the error and makes no checks.

KV can take up to 60 seconds to show a new value in all locations. Thus a push can take effect one or two runs late.

Secrets go in Cloudflare only:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put DMS_PING_TOKEN   # optional, see Heartbeat
```

A header value of the form `secret:NAME` makes the Worker read `env.NAME`. Set each such secret with `wrangler secret put NAME`. The schema rejects `secret:TELEGRAM_BOT_TOKEN`, `secret:TELEGRAM_CHAT_ID`, and `secret:DMS_PING_TOKEN`, so a monitor cannot send these secrets to a target.

## Local test run

1. Load the config into local KV: `npm run config:push -- monitors.example.yaml --local`.
2. Start the Worker: `npm run dev`.
3. Start a cron run: `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.
4. Read the line that starts with `{"minute"` in the Wrangler output. It has one result for each monitor and region.

Local Wrangler ignores location hints, so all regions show the same colo.

## Known behavior

- Authelia forward-auth returns `401` to a Worker `fetch()`, but `302` to `curl`.
- `tcp: { tls: true }` checks the certificate. A self-signed certificate fails.
- A Worker cannot open TCP to port 25 or to a Cloudflare IP address, and it has no UDP.
