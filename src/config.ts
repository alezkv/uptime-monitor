// The shape of the "config" key in KV. Phase 4 adds a Zod schema for it.

/** Cloudflare puts `sam`, `afr`, and `me` objects in a nearby region. */
export type Region = DurableObjectLocationHint;

export interface Alert {
	/** Consecutive failures before a region counts as down. */
	failThreshold: number;
	/** Down regions before the monitor counts as down. */
	regionQuorum: number;
}

export interface HttpCheck {
	method?: string;
	/** Default: [200]. Redirects are not followed, so a 302 can be an expected status. */
	expectStatus?: number[];
	bodyContains?: string;
	/** A value of the form `secret:NAME` is read from `env.NAME` at run time. */
	headers?: Record<string, string>;
}

export interface TcpCheck {
	tls?: boolean;
}

export interface Monitor {
	/** Stable key for the state. A new id starts with no history. */
	id: string;
	name: string;
	type: "http" | "tcp";
	/** A URL for `http`, `host:port` for `tcp`. */
	target: string;
	enabled?: boolean;
	/** Minutes. */
	interval?: number;
	/** Milliseconds. */
	timeout?: number;
	regions?: Region[];
	http?: HttpCheck;
	tcp?: TcpCheck;
	alert?: Partial<Alert>;
}

export interface Config {
	defaults: {
		regions: Region[];
		interval: number;
		timeout: number;
		alert: Alert;
	};
	monitors: Monitor[];
}

/** A monitor with the defaults merged in. */
export interface Resolved {
	id: string;
	name: string;
	type: "http" | "tcp";
	target: string;
	interval: number;
	timeout: number;
	regions: Region[];
	http: HttpCheck;
	tcp: TcpCheck;
	alert: Alert;
}

/** The result of one check of one monitor from one region. */
export interface Result {
	id: string;
	region: Region;
	/** The data center that ran the check, from /cdn-cgi/trace. */
	colo: string;
	ok: boolean;
	status?: number;
	ms: number;
	error?: string;
	at: number;
}

/** The enabled monitors, with the defaults merged in. */
export function resolve(config: Config): Resolved[] {
	const d = config.defaults;
	return config.monitors
		.filter((m) => m.enabled !== false)
		.map((m) => ({
			id: m.id,
			name: m.name,
			type: m.type,
			target: m.target,
			interval: m.interval ?? d.interval,
			timeout: m.timeout ?? d.timeout,
			regions: m.regions ?? d.regions,
			http: m.http ?? {},
			tcp: m.tcp ?? {},
			alert: { ...d.alert, ...m.alert },
		}));
}

/** FNV-1a. The slot of a monitor stays the same across runs and deploys. */
export function hash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** `minute` is minutes since the epoch. */
export function isDue(m: Resolved, minute: number): boolean {
	return m.interval <= 1 || minute % m.interval === hash(m.id) % m.interval;
}

export function byRegion(monitors: Resolved[]): Map<Region, Resolved[]> {
	const groups = new Map<Region, Resolved[]>();
	for (const m of monitors) {
		for (const r of m.regions) {
			const list = groups.get(r) ?? [];
			list.push(m);
			groups.set(r, list);
		}
	}
	return groups;
}
