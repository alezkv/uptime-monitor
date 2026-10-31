// The shape of the "config" key in KV. Phase 4 adds a Zod schema for it.

/** Durable Object location hints. Cloudflare puts `sam`, `afr`, and `me` objects in a nearby region. */
export type Region =
	| "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac"
	| "apac-ne" | "apac-se" | "oc" | "afr" | "me";

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
