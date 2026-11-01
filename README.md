# uptime-monitor

A Cloudflare Worker that checks HTTP and TCP endpoints from more than one region and sends a Telegram alert when an endpoint goes down. It runs on the Workers free plan.

Status: the code for phases 1 to 5 is complete, and the tests pass. The Worker runs on Cloudflare since 2026-11-01, and a test alert reached Telegram. The status endpoint of phase 7 is complete, but it is not deployed.

## How it works

1. A Cron Trigger starts the Worker each minute.
2. The Worker reads the config from the `config` key in KV and selects the monitors that are due.
3. For each region, the Worker calls a `Probe` Durable Object. Each `Probe` object has a location hint for its region, so its checks leave from that region.
4. The Worker sends all results to the `State` Durable Object.
5. `State` counts the failures. It sends a Telegram message when a monitor goes down or recovers.
6. `GET /status` shows the state of each monitor. It needs a token. See [Status endpoint](#status-endpoint).

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

## Endpoints

| Request | Result |
|---|---|
| `GET /status` with `Authorization: Bearer <STATUS_TOKEN>` | The state of each monitor and region, as JSON. See [Status endpoint](#status-endpoint). |
| Any other path | `404`. |

## Configuration

The repository has no real list of monitors. `monitors.example.yaml` shows the format. Keep the real list in a file outside the repository.

The schema is in `src/config.ts`. It rejects an unknown field, so a misspelled field name gives an error and is not ignored. The cron handler validates the config on each run. If the config is not valid, the handler logs the error and makes no checks.

KV can take up to 60 seconds to show a new value in all locations. Thus a push can take effect one or two runs late.

Secrets go in Cloudflare only:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put STATUS_TOKEN
```

`STATUS_TOKEN` is optional. With no value, `GET /status` returns `404`. For `npm run dev`, put the secrets in `.dev.vars`. `.dev.vars.example` shows the format.

A header value of the form `secret:NAME` makes the Worker read `env.NAME`. Set each such secret with `wrangler secret put NAME`. The schema rejects `secret:TELEGRAM_BOT_TOKEN` and `secret:TELEGRAM_CHAT_ID`, so a monitor cannot send these secrets to a target.

## Status endpoint

`GET /status` returns the state that `State` holds, as JSON. To read it:

```sh
curl -H "Authorization: Bearer $STATUS_TOKEN" https://uptime.<account>.workers.dev/status
```

The answers:

| Status | When |
|---|---|
| `200` | The token is correct. The body is the JSON below. |
| `401` | The token is missing or wrong. The body has no data. |
| `404` | The `STATUS_TOKEN` secret is not set. The route is off. |
| `405` | The method is not `GET`. |
| `503` | KV has no valid config. |

Each answer has `Cache-Control: no-store`. The Worker compares SHA-256 digests of the tokens in constant time.

An example body:

```json
{
  "now": 1761955260000,
  "lastRun": 1761955200000,
  "memorySince": 1761951600000,
  "note": "last and lastRun are in memory only. They are null after the State object restarts, until the next check.",
  "probes": [{ "region": "weur", "misses": 0, "alerted": false }],
  "monitors": [
    {
      "id": "auth",
      "name": "Authelia",
      "type": "http",
      "target": "https://auth.example.com/api/health",
      "state": "up",
      "since": null,
      "regions": [
        {
          "region": "weur",
          "state": "up",
          "fails": 0,
          "last": { "colo": "LHR", "ok": true, "status": 200, "ms": 95, "at": 1761955200100 }
        }
      ]
    }
  ]
}
```

- All times are milliseconds since the epoch.
- `state` of a monitor is the state that the alerts use. It changes only after Telegram accepts the alert. `since` is the time of the "down" alert.
- `state` of a region is `down` after `failThreshold` failures in a row. The `fails` count stops at `failThreshold`.
- `last` holds `colo`, `ok`, `status`, `error`, `ms`, and `at`. A field with no value is absent.
- `probes` has each region that the config uses. `misses` counts the runs in a row with no result from that region. The count stops at 5.
- The answer has the monitors of the current config only. It has no `http` settings, so it shows no header and no `secret:` value.

`last` and `lastRun` are in memory only. A write on each run would use most of the free limit of SQLite rows. When Cloudflare restarts the `State` object, these fields are `null` until the next check. `memorySince` tells when the current copy of the object started. The `fails` counts and the up or down state are in SQLite, so a restart keeps them.

Each request uses 1 Worker invocation, 1 KV read, and 1 Durable Object request. It writes no row.

`wrangler.toml` has no `workers_dev` key, so each deploy enables `uptime.<account>.workers.dev`. Thus `/status` is open to the internet, and only the token protects it. Later, you can put Cloudflare Access in front of the route as a second lock.

## Local test run

1. Load the config into local KV: `npm run config:push -- monitors.example.yaml --local`.
2. Start the Worker: `npm run dev`.
3. Start a cron run: `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.
4. Read the line that starts with `{"minute"` in the Wrangler output. It has one result for each monitor and region.
5. Read the status: `curl -H "Authorization: Bearer <STATUS_TOKEN from .dev.vars>" http://localhost:8787/status`.

Local Wrangler ignores location hints, so all regions show the same colo.

## Known behavior

- Authelia forward-auth returns `401` to a Worker `fetch()`, but `302` to `curl`.
- `tcp: { tls: true }` checks the certificate. A self-signed certificate fails.
- A Worker cannot open TCP to port 25 or to a Cloudflare IP address, and it has no UDP.
