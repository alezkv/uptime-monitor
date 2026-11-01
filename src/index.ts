import { byRegion, isDue, parseConfig, type Region, resolve, type Result } from "./config";
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
		const raw = await env.CONFIG.get("config");
		if (raw === null) {
			console.warn("no config in KV, key \"config\"");
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			console.error("config in KV is not valid JSON");
			return;
		}
		const parsed = parseConfig(value);
		if (!parsed.ok) {
			console.error(`config in KV is not valid:\n${parsed.error}`);
			return;
		}
		const config = parsed.config;

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

	// Phase 7 (optional): GET /status.
	async fetch(): Promise<Response> {
		return new Response("not found\n", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
