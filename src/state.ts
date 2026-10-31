import { DurableObject } from "cloudflare:workers";
import { type Config, type Region, type Resolved, resolve, type Result } from "./config";
import { notify } from "./telegram";

/** Consecutive runs with no result from a region before the "probe failed" alert. */
export const PROBE_MISS_LIMIT = 5;

interface ProbeRow {
	misses: number;
	alerted: boolean;
}

/**
 * The one object that holds the up or down state of each monitor and sends the alerts.
 *
 * The free plan allows 100,000 SQLite rows written per day. Thus the tables are sparse,
 * and a row changes only when its value changes:
 * - `fails` has a row only for a pair of monitor and region that fails. The count stops
 *   at `failThreshold`, so a long outage does not write a row on each run.
 * - `down` has a row only for a monitor that is down.
 * - `probes` has a row only for a region whose Probe call failed.
 */
export class State extends DurableObject<Env> {
	/** The last result of each monitor and region, for the alert text. Memory only. */
	private last = new Map<string, Result>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS fails (id TEXT NOT NULL, region TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (id, region));
			CREATE TABLE IF NOT EXISTS down (id TEXT PRIMARY KEY, since INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS probes (region TEXT PRIMARY KEY, misses INTEGER NOT NULL, alerted INTEGER NOT NULL);
		`);
	}

	/** `missing` lists the regions whose Probe call failed. They give no result in this run. */
	async record(config: Config, results: Result[], missing: Region[]): Promise<void> {
		const monitors = new Map(resolve(config).map((m) => [m.id, m]));
		const fails = this.loadFails();
		const down = this.loadDown();
		this.forget(monitors, fails, down);

		const checked = new Set<string>();
		for (const r of results) {
			const m = monitors.get(r.id);
			if (!m) continue;
			checked.add(r.id);
			const k = key(r.id, r.region);
			this.last.set(k, r);
			const before = fails.get(k) ?? 0;
			const after = r.ok ? 0 : Math.min(before + 1, m.alert.failThreshold);
			if (after === before) continue;
			if (after === 0) {
				fails.delete(k);
				this.sql("DELETE FROM fails WHERE id = ? AND region = ?", r.id, r.region);
			} else {
				fails.set(k, after);
				this.sql("INSERT OR REPLACE INTO fails (id, region, n) VALUES (?, ?, ?)", r.id, r.region, after);
			}
		}

		for (const id of checked) {
			const m = monitors.get(id)!;
			const isDown = isMonitorDown(m, fails);
			const since = down.get(id);
			if (isDown === (since !== undefined)) continue;

			const now = Date.now();
			const lines = m.regions.map((r) => line(r, this.last.get(key(id, r))));
			const text =
				since === undefined
					? [`🔴 DOWN ${m.name} (${where(m)})`, ...lines].join("\n")
					: [`✅ RECOVERED ${m.name} (${where(m)}) after ${duration(now - since)}`, ...lines].join("\n");
			// Save the change only after Telegram accepts it. Otherwise the next run tries again.
			if (!(await this.send(text))) continue;
			if (isDown) this.sql("INSERT OR REPLACE INTO down (id, since) VALUES (?, ?)", id, now);
			else this.sql("DELETE FROM down WHERE id = ?", id);
		}

		await this.recordProbes(new Set(results.map((r) => r.region)), missing, monitors);
	}

	/** A failed Probe call does not count as a failure of its monitors. This alert tells that a region checks nothing. */
	private async recordProbes(reported: Set<Region>, missing: Region[], monitors: Map<string, Resolved>) {
		const rows = new Map<string, ProbeRow>();
		for (const row of this.sql<{ region: string; misses: number; alerted: number }>("SELECT * FROM probes")) {
			rows.set(row.region, { misses: row.misses, alerted: row.alerted === 1 });
		}

		const used = new Set([...monitors.values()].flatMap((m) => m.regions));
		for (const region of rows.keys()) {
			if (!used.has(region as Region)) this.sql("DELETE FROM probes WHERE region = ?", region);
		}

		for (const region of missing) {
			const before = rows.get(region) ?? { misses: 0, alerted: false };
			const after = { misses: Math.min(before.misses + 1, PROBE_MISS_LIMIT), alerted: before.alerted };
			if (after.misses >= PROBE_MISS_LIMIT && !after.alerted) {
				after.alerted = await this.send(
					`⚠️ PROBE ${region} failed in ${PROBE_MISS_LIMIT} runs in a row. Its monitors are not checked from ${region}.`,
				);
			}
			if (after.misses === before.misses && after.alerted === before.alerted) continue;
			this.sql(
				"INSERT OR REPLACE INTO probes (region, misses, alerted) VALUES (?, ?, ?)",
				region,
				after.misses,
				after.alerted ? 1 : 0,
			);
		}

		for (const region of reported) {
			const row = rows.get(region);
			if (!row) continue;
			if (row.alerted && !(await this.send(`✅ PROBE ${region} works again.`))) continue;
			this.sql("DELETE FROM probes WHERE region = ?", region);
		}
	}

	/** Deletes the state of a monitor or a region that is no longer in the config. */
	private forget(monitors: Map<string, Resolved>, fails: Map<string, number>, down: Map<string, number>) {
		for (const k of fails.keys()) {
			const [id, region] = split(k);
			if (monitors.get(id)?.regions.includes(region)) continue;
			fails.delete(k);
			this.last.delete(k);
			this.sql("DELETE FROM fails WHERE id = ? AND region = ?", id, region);
		}
		for (const id of down.keys()) {
			if (monitors.has(id)) continue;
			down.delete(id);
			this.sql("DELETE FROM down WHERE id = ?", id);
		}
		for (const k of this.last.keys()) {
			const [id, region] = split(k);
			if (!monitors.get(id)?.regions.includes(region)) this.last.delete(k);
		}
	}

	private loadFails(): Map<string, number> {
		const rows = this.sql<{ id: string; region: string; n: number }>("SELECT * FROM fails");
		return new Map(rows.map((r) => [key(r.id, r.region as Region), r.n]));
	}

	private loadDown(): Map<string, number> {
		const rows = this.sql<{ id: string; since: number }>("SELECT * FROM down");
		return new Map(rows.map((r) => [r.id, r.since]));
	}

	/** Returns false if Telegram did not accept the message. */
	private async send(text: string): Promise<boolean> {
		try {
			await notify(this.env, text);
			return true;
		} catch (err) {
			console.error("alert failed", err);
			return false;
		}
	}

	private sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
		return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
	}
}

/** A region is down after `failThreshold` failures. The monitor is down when enough regions are down. */
export function isMonitorDown(m: Resolved, fails: Map<string, number>): boolean {
	const downRegions = m.regions.filter((r) => (fails.get(key(m.id, r)) ?? 0) >= m.alert.failThreshold).length;
	return downRegions >= Math.min(m.alert.regionQuorum, m.regions.length);
}

/** One line of the alert text, for example `weur FRA: status 503, expected 200 (120 ms)`. */
export function line(region: Region, r: Result | undefined): string {
	if (!r) return `${region}: no result`;
	const outcome = r.ok ? "ok" : (r.error ?? "failed");
	// A timeout error already gives the time.
	const ms = r.ok || r.status !== undefined ? ` (${r.ms} ms)` : "";
	return `${region} ${r.colo}: ${outcome}${ms}`;
}

/** `12 min`, `3 h 5 min`, `2 d 4 h`. */
export function duration(ms: number): string {
	const min = Math.max(1, Math.round(ms / 60_000));
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h} h ${min % 60} min`;
	return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function where(m: Resolved): string {
	if (m.type !== "http") return m.target;
	try {
		return new URL(m.target).host;
	} catch {
		return m.target;
	}
}

// A monitor id can hold any text, but a region name has no space.
function key(id: string, region: Region): string {
	return `${region} ${id}`;
}

function split(k: string): [string, Region] {
	const i = k.indexOf(" ");
	return [k.slice(i + 1), k.slice(0, i) as Region];
}
