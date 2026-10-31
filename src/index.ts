import { Probe } from "./probe";
import { State } from "./state";

export { Probe, State };

export default {
	// Phase 2: read the config, pick the due monitors, run them in each region, send the results to State.
	async scheduled(_controller, _env, _ctx): Promise<void> {},

	// Phase 7 (optional): GET /status.
	async fetch(): Promise<Response> {
		return new Response("not found\n", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
