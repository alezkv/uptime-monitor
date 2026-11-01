import type { Result } from "./config";

/** An error text longer than this is cut, so that the blobs of one point stay far below the 16 KB limit. */
export const MAX_ERROR = 256;

/**
 * Writes one data point for each check result to Workers Analytics Engine.
 *
 * The order of the values is the schema of the `uptime_results` dataset. Do not move a value.
 * Add a new value at the end only.
 *
 * - `index1`: monitor id
 * - `blob1`: region, `blob2`: colo, `blob3`: error text or ""
 * - `double1`: time of the check in ms, `double2`: 1 when the check passed, else 0,
 *   `double3`: HTTP status, or 0 for a TCP check or no response
 *
 * A region whose `Probe` call failed has no result, and thus no point.
 * The history is optional. With no binding, this does nothing. It never throws.
 */
export function writeHistory(env: Partial<Pick<Env, "HISTORY">>, results: Result[]): void {
	if (!env.HISTORY) return;
	for (const r of results) {
		try {
			env.HISTORY.writeDataPoint({
				indexes: [r.id],
				blobs: [r.region, r.colo, (r.error ?? "").slice(0, MAX_ERROR)],
				doubles: [r.ms, r.ok ? 1 : 0, r.status ?? 0],
			});
		} catch (err) {
			// One bad point must not stop the others, or the alerts.
			console.error(`history write failed for ${r.id} ${r.region}`, err);
		}
	}
}
