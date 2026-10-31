import { byRegion, type Config, isDue, type Region, resolve, type Result } from "./config";
import { Probe } from "./probe";
import { State } from "./state";

export { Probe, State };

export default {
	async scheduled(controller, env): Promise<void> {
		const config = await env.CONFIG.get<Config>("config", "json");
		if (!config) {
			console.warn("no config in KV, key \"config\"");
			return;
		}

		const minute = Math.floor(controller.scheduledTime / 60_000);
		const groups = [...byRegion(resolve(config).filter((m) => isDue(m, minute)))];
		if (groups.length === 0) return;

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
	},

	// Phase 7 (optional): GET /status.
	async fetch(): Promise<Response> {
		return new Response("not found\n", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
