import { DurableObject } from "cloudflare:workers";
import type { Monitor, Region, Result } from "./config";

/** One object for each region. Its checks leave from the data center that holds it. */
export class Probe extends DurableObject<Env> {
	// Phase 1: HTTP checks with fetch(), TCP checks with connect(), 6 at a time.
	async run(_region: Region, _monitors: Monitor[]): Promise<Result[]> {
		return [];
	}
}
