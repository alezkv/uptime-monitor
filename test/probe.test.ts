import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hash, isDue, type Resolved } from "../src/config";
import { check } from "../src/probe";

function monitor(change: Partial<Resolved> = {}): Resolved {
	return {
		id: "web",
		name: "Web",
		type: "http",
		target: "https://web.example.test/health",
		interval: 1,
		timeout: 1000,
		regions: ["weur"],
		http: {},
		tcp: {},
		alert: { failThreshold: 2, regionQuorum: 2 },
		...change,
	};
}

/** Answers each fetch with `respond`. A fetch that never ends rejects when its signal aborts. */
function mockFetch(respond: (req: Request) => Response | "hang") {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		const req = new Request(input, init);
		const res = respond(req);
		if (res !== "hang") return Promise.resolve(res);
		return new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason)));
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

describe("isDue", () => {
	const minutes = Array.from({ length: 20 }, (_, i) => 29_000_000 + i);

	it("runs a monitor with interval 5 in 1 of 5 runs, in the slot of its id", () => {
		const ids = ["web", "api", "imaps", "vpn", "mail", "dns"];
		const slots = ids.map((id) => {
			const due = minutes.filter((t) => isDue(monitor({ id, interval: 5 }), t));
			expect(due).toHaveLength(4);
			expect(new Set(due.map((t) => t % 5))).toEqual(new Set([hash(id) % 5]));
			return hash(id) % 5;
		});
		// The hash spreads the monitors across the 5 minutes.
		expect(new Set(slots).size).toBeGreaterThan(1);
	});

	it("runs a monitor with interval 1 in each run", () => {
		expect(minutes.every((t) => isDue(monitor(), t))).toBe(true);
	});
});

describe("http check", () => {
	it("passes on the expected status", async () => {
		const spy = mockFetch(() => new Response("ok"));
		expect(await check(monitor(), env)).toEqual({ ok: true, status: 200 });
		const req = new Request(...(spy.mock.calls[0] as [RequestInfo, RequestInit]));
		expect(req.redirect).toBe("manual");
		expect(req.headers.get("user-agent")).toBe("uptime-monitor");
	});

	it("fails on another status", async () => {
		mockFetch(() => new Response("bad gateway", { status: 502 }));
		expect(await check(monitor(), env)).toEqual({ ok: false, status: 502, error: "status 502, expected 200" });
	});

	it("passes on a 302 when expectStatus is [302]", async () => {
		mockFetch(() => new Response(null, { status: 302, headers: { location: "https://auth.example.test/" } }));
		const m = monitor({ http: { expectStatus: [302, 401] } });
		expect(await check(m, env)).toEqual({ ok: true, status: 302 });
	});

	it("fails on a 302 when expectStatus is the default", async () => {
		mockFetch(() => new Response(null, { status: 302, headers: { location: "https://auth.example.test/" } }));
		expect(await check(monitor(), env)).toMatchObject({ ok: false, status: 302 });
	});

	it("fails after the timeout", async () => {
		mockFetch(() => "hang");
		const start = Date.now();
		expect(await check(monitor({ timeout: 100 }), env)).toEqual({ ok: false, error: "timeout after 100 ms" });
		expect(Date.now() - start).toBeLessThan(1000);
	});

	it("passes when the body contains the text, and fails when it does not", async () => {
		mockFetch(() => new Response("status: operational"));
		expect(await check(monitor({ http: { bodyContains: "operational" } }), env)).toEqual({ ok: true, status: 200 });
		expect(await check(monitor({ http: { bodyContains: "pong" } }), env)).toEqual({
			ok: false,
			status: 200,
			error: 'body does not contain "pong"',
		});
	});

	it("fails on a network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network connection lost."));
		expect(await check(monitor(), env)).toEqual({ ok: false, error: "Network connection lost." });
	});
});

describe("headers", () => {
	it("reads a secret: value from env", async () => {
		const spy = mockFetch(() => new Response("ok"));
		// TELEGRAM_CHAT_ID is the one string secret in the test env. The schema rejects it in a real config.
		const m = monitor({ http: { headers: { "x-token": "secret:TELEGRAM_CHAT_ID", "x-plain": "a" } } });
		expect(await check(m, env)).toMatchObject({ ok: true });
		const req = new Request(...(spy.mock.calls[0] as [RequestInfo, RequestInit]));
		expect(req.headers.get("x-token")).toBe("42");
		expect(req.headers.get("x-plain")).toBe("a");
	});

	it("gives a failed check, not an exception, when a secret is missing", async () => {
		const spy = mockFetch(() => new Response("ok"));
		const m = monitor({ http: { headers: { authorization: "secret:NO_SUCH_SECRET" } } });
		expect(await check(m, env)).toEqual({ ok: false, error: "missing secret NO_SUCH_SECRET" });
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("tcp check", () => {
	it("fails on a target with no port, before it connects", async () => {
		expect(await check(monitor({ type: "tcp", target: "mx.example.test" }), env)).toEqual({
			ok: false,
			error: "bad target mx.example.test, expected host:port",
		});
	});
});

describe("Probe", () => {
	it("adds the colo to each result and looks it up only one time", async () => {
		const spy = mockFetch((req) =>
			req.url === "https://www.cloudflare.com/cdn-cgi/trace" ? new Response("fl=1\ncolo=FRA\nip=1.2.3.4\n") : new Response("ok"),
		);
		const stub = env.PROBE.getByName("probe-weur");
		const first = await stub.run("weur", [monitor(), monitor({ id: "b" })]);
		const second = await stub.run("weur", [monitor()]);
		expect(first.map((r) => [r.id, r.region, r.colo, r.ok])).toEqual([
			["web", "weur", "FRA", true],
			["b", "weur", "FRA", true],
		]);
		expect(second[0].colo).toBe("FRA");
		expect(spy.mock.calls.filter(([input]) => String(input).includes("cdn-cgi/trace"))).toHaveLength(1);
		expect(await runInDurableObject(stub, (_, state) => state.storage.get("colo"))).toBe("FRA");
	});

	it("gives colo unknown and does not save it when the lookup fails", async () => {
		mockFetch((req) => (req.url.includes("cdn-cgi/trace") ? new Response("no colo here") : new Response("ok")));
		const stub = env.PROBE.getByName("probe-eeur");
		const [result] = await stub.run("eeur", [monitor()]);
		expect(result.colo).toBe("unknown");
		expect(await runInDurableObject(stub, (_, state) => state.storage.get("colo"))).toBeUndefined();
	});
});
