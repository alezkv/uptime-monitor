import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";
import type { Region, Resolved, Result } from "./config";

const TRACE = "https://www.cloudflare.com/cdn-cgi/trace";
const PARALLEL = 6;

type Outcome = Pick<Result, "ok" | "status" | "error">;

/** One object for each region. Its checks leave from the data center that holds it. */
export class Probe extends DurableObject<Env> {
	async run(region: Region, monitors: Resolved[]): Promise<Result[]> {
		const colo = await this.colo();
		return pool(monitors, PARALLEL, async (m) => {
			const at = Date.now();
			const outcome = await check(m, this.env);
			return { id: m.id, region, colo, at, ms: Date.now() - at, ...outcome };
		});
	}

	/** An object never moves, so one lookup is enough. */
	private async colo(): Promise<string> {
		const saved = await this.ctx.storage.get<string>("colo");
		if (saved) return saved;
		try {
			const res = await fetch(TRACE, { signal: AbortSignal.timeout(5000) });
			const colo = (await res.text()).match(/^colo=(\w+)$/m)?.[1];
			if (!colo) return "unknown";
			await this.ctx.storage.put("colo", colo);
			return colo;
		} catch {
			return "unknown";
		}
	}
}

export async function check(m: Resolved, env: Env): Promise<Outcome> {
	try {
		return m.type === "http" ? await httpCheck(m, env) : await tcpCheck(m);
	} catch (err) {
		return { ok: false, error: describe(err, m.timeout) };
	}
}

async function httpCheck(m: Resolved, env: Env): Promise<Outcome> {
	const res = await fetch(m.target, {
		method: m.http.method ?? "GET",
		headers: headers(m.http.headers, env),
		redirect: "manual",
		cache: "no-store",
		signal: AbortSignal.timeout(m.timeout),
	});
	const expect = m.http.expectStatus ?? [200];
	if (!expect.includes(res.status)) {
		await res.body?.cancel();
		return { ok: false, status: res.status, error: `status ${res.status}, expected ${expect.join(" or ")}` };
	}
	if (m.http.bodyContains === undefined) {
		await res.body?.cancel();
		return { ok: true, status: res.status };
	}
	const body = await res.text();
	if (!body.includes(m.http.bodyContains)) {
		return { ok: false, status: res.status, error: `body does not contain "${m.http.bodyContains}"` };
	}
	return { ok: true, status: res.status };
}

async function tcpCheck(m: Resolved): Promise<Outcome> {
	const i = m.target.lastIndexOf(":");
	const hostname = m.target.slice(0, i);
	const port = Number(m.target.slice(i + 1));
	if (i < 1 || !Number.isInteger(port)) return { ok: false, error: `bad target ${m.target}, expected host:port` };

	const socket = connect({ hostname, port }, { secureTransport: m.tcp.tls ? "on" : "off", allowHalfOpen: false });
	try {
		await withTimeout(socket.opened, m.timeout);
		return { ok: true };
	} finally {
		socket.close().catch(() => {});
	}
}

class MissingSecret extends Error {}

function headers(spec: Record<string, string> | undefined, env: Env): Headers {
	const h = new Headers({ "user-agent": "uptime-monitor" });
	const vars = env as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(spec ?? {})) {
		if (!value.startsWith("secret:")) {
			h.set(key, value);
			continue;
		}
		const name = value.slice("secret:".length);
		const secret = vars[name];
		if (typeof secret !== "string") throw new MissingSecret(`missing secret ${name}`);
		h.set(key, secret);
	}
	return h;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: number | null = null;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DOMException("timeout", "TimeoutError")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describe(err: unknown, timeout: number): string {
	if (err instanceof MissingSecret) return err.message;
	if (err instanceof Error && err.name === "TimeoutError") return `timeout after ${timeout} ms`;
	return err instanceof Error ? err.message : String(err);
}

/** Runs `fn` on each item, with at most `limit` calls at the same time. Keeps the order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
