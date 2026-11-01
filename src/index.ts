import { byRegion, type Config, isDue, parseConfig, type Region, resolve, type Result } from "./config";
import { heartbeat } from "./heartbeat";
import { Probe } from "./probe";
import { State } from "./state";

export { Probe, State };

// REGIONS in config.ts must hold each location hint of the runtime, and no other value.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type RegionsMatch = Assert<Same<Region, DurableObjectLocationHint>>;

export default {
	async scheduled(controller, env): Promise<void> {
		const loaded = await loadConfig(env);
		if (!loaded.ok) {
			if (loaded.missing) console.warn(loaded.error);
			else console.error(loaded.detail ? `${loaded.error}:\n${loaded.detail}` : loaded.error);
			return;
		}
		const config = loaded.config;

		const minute = Math.floor(controller.scheduledTime / 60_000);
		const groups = [...byRegion(resolve(config).filter((m) => isDue(m, minute)))];
		// No monitor is due, but the run is complete.
		if (groups.length === 0) return heartbeat(env);

		// One failed region must not stop the others.
		const settled = await Promise.allSettled(
			groups.map(([region, monitors]) =>
				env.PROBE.getByName(`probe-${region}`, { locationHint: region }).run(region, monitors),
			),
		);

		const results: Result[] = [];
		const missing: Region[] = [];
		settled.forEach((s, i) => {
			const region = groups[i][0];
			if (s.status === "fulfilled") results.push(...s.value);
			else {
				missing.push(region);
				console.error(`probe ${region} failed: ${s.reason}`);
			}
		});

		console.log(JSON.stringify({ minute, results, missing }));
		await env.STATE.getByName("state").record(config, results, missing);
		// Only a run that got to this line pings. A run that stops early gives no ping, so `dms` sends an alert.
		await heartbeat(env);
	},

	/** `GET /status` with `Authorization: Bearer <STATUS_TOKEN>`. Each other path gives 404. */
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		// With no token, the route is off.
		if (url.pathname !== "/status" || !env.STATUS_TOKEN) return text(404, "not found");
		if (request.method !== "GET") return text(405, "method not allowed", { allow: "GET" });
		if (!(await authorized(request, env.STATUS_TOKEN))) {
			return text(401, "unauthorized", { "www-authenticate": 'Bearer realm="uptime"' });
		}

		const loaded = await loadConfig(env);
		// The detail goes to the log only.
		if (!loaded.ok) return json(503, { error: loaded.error });
		return json(200, await env.STATE.getByName("state").status(loaded.config));
	},
} satisfies ExportedHandler<Env>;

type Loaded = { ok: true; config: Config } | { ok: false; error: string; missing?: true; detail?: string };

/** Reads and validates the "config" key from KV. */
async function loadConfig(env: Env): Promise<Loaded> {
	const raw = await env.CONFIG.get("config");
	if (raw === null) return { ok: false, missing: true, error: 'no config in KV, key "config"' };
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, error: "config in KV is not valid JSON" };
	}
	const parsed = parseConfig(value);
	if (!parsed.ok) return { ok: false, error: "config in KV is not valid", detail: parsed.error };
	return { ok: true, config: parsed.config };
}

/** Compares SHA-256 digests in constant time, so the time does not tell how much of the token is correct. */
async function authorized(request: Request, token: string): Promise<boolean> {
	const match = /^Bearer +(\S+) *$/i.exec(request.headers.get("authorization") ?? "");
	if (!match) return false;
	const [given, expected] = await Promise.all([sha256(match[1]), sha256(token)]);
	return crypto.subtle.timingSafeEqual(given, expected);
}

function sha256(s: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

// No cache must keep a status answer or an error.
const NO_STORE = { "cache-control": "no-store" };

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(`${body}\n`, {
		status,
		headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8", ...headers },
	});
}

function json(status: number, body: unknown): Response {
	return new Response(`${JSON.stringify(body, null, 2)}\n`, {
		status,
		headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
	});
}
