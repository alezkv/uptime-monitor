// The shape of the "config" key in KV. The types come from the schema.
//
// Node.js runs scripts/config.ts with this file, so this file must not use the
// Workers types or import a file without its `.ts` extension.
import { z } from "zod";

/**
 * The location hints of Durable Objects. Cloudflare puts `sam`, `afr`, and `me` objects in a
 * nearby region. src/index.ts makes sure that this list matches `DurableObjectLocationHint`.
 */
export const REGIONS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"] as const;
export const Region = z.enum(REGIONS);
export type Region = z.infer<typeof Region>;

/** The probe sends a header to the target, so a header must never name one of these secrets. */
const PRIVATE_SECRETS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DMS_PING_TOKEN"];

const regions = z
	.array(Region)
	.min(1)
	.refine((list) => new Set(list).size === list.length, "a region is in the list more than one time");

export const Alert = z.strictObject({
	/** Consecutive failures before a region counts as down. */
	failThreshold: z.int().min(1).max(60),
	/** Down regions before the monitor counts as down. */
	regionQuorum: z.int().min(1),
});
export type Alert = z.infer<typeof Alert>;

const header = z.string().refine((value) => {
	if (!value.startsWith("secret:")) return true;
	const name = value.slice("secret:".length);
	return /^\w+$/.test(name) && !PRIVATE_SECRETS.includes(name);
}, "a secret: value must name a secret, and not a Telegram or heartbeat secret");

export const HttpCheck = z.strictObject({
	method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).optional(),
	/** Default: [200]. Redirects are not followed, so a 302 can be an expected status. */
	expectStatus: z.array(z.int().min(100).max(599)).min(1).optional(),
	bodyContains: z.string().min(1).optional(),
	/** A value of the form `secret:NAME` is read from `env.NAME` at run time. */
	headers: z.record(z.string().min(1), header).optional(),
});
export type HttpCheck = z.infer<typeof HttpCheck>;

export const TcpCheck = z.strictObject({
	tls: z.boolean().optional(),
});
export type TcpCheck = z.infer<typeof TcpCheck>;

/** Minutes. A run each minute, so 1 is the shortest interval. */
const interval = z.int().min(1).max(1440);
/** Milliseconds. A check must end before the next run starts. */
const timeout = z.int().min(100).max(30_000);

export const Monitor = z
	.strictObject({
		/** Stable key for the state. A new id starts with no history. */
		id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "use only a-z, 0-9, '.', '_', and '-'"),
		name: z.string().min(1),
		type: z.enum(["http", "tcp"]),
		/** A URL for `http`, `host:port` for `tcp`. */
		target: z.string(),
		enabled: z.boolean().optional(),
		interval: interval.optional(),
		timeout: timeout.optional(),
		regions: regions.optional(),
		http: HttpCheck.optional(),
		tcp: TcpCheck.optional(),
		alert: Alert.partial().optional(),
	})
	.superRefine((m, ctx) => {
		const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
		if (m.type === "http") {
			if (m.tcp) issue("tcp", "an http monitor cannot have tcp settings");
			if (!/^https?:\/\/[^/]/.test(m.target) || !URL.canParse(m.target)) issue("target", "expected an http or https URL");
		} else {
			if (m.http) issue("http", "a tcp monitor cannot have http settings");
			const match = /^([^\s:/]+):(\d+)$/.exec(m.target);
			const port = Number(match?.[2]);
			if (!match || port < 1 || port > 65535) issue("target", "expected host:port");
		}
	});
export type Monitor = z.infer<typeof Monitor>;

export const Config = z
	.strictObject({
		defaults: z.strictObject({ regions, interval, timeout, alert: Alert }),
		monitors: z.array(Monitor),
	})
	.superRefine((config, ctx) => {
		const seen = new Set<string>();
		config.monitors.forEach((m, i) => {
			if (seen.has(m.id)) ctx.addIssue({ code: "custom", path: ["monitors", i, "id"], message: `duplicate id ${m.id}` });
			seen.add(m.id);
		});
	});
export type Config = z.infer<typeof Config>;

/** Validates a value from KV or from a file. The error text names each field that is not valid. */
export function parseConfig(value: unknown): { ok: true; config: Config } | { ok: false; error: string } {
	const result = Config.safeParse(value);
	return result.success ? { ok: true, config: result.data } : { ok: false, error: z.prettifyError(result.error) };
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
