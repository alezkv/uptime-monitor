import { DurableObject } from "cloudflare:workers";
import type { Config, Region, Result } from "./config";

/** The one object that holds the up or down state of each monitor and sends the alerts. */
export class State extends DurableObject<Env> {
	// Phase 3: count failures per monitor and region, apply the quorum, alert on a change.
	// `missing` lists the regions whose Probe call failed. They give no result in this run.
	async record(_config: Config, _results: Result[], _missing: Region[]): Promise<void> {}
}
