import { createScheduledController, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config";
import worker from "../src/index";
import type { Status } from "../src/state";

const config: Config = {
	defaults: { regions: ["weur", "eeur", "enam"], interval: 1, timeout: 1000, alert: { failThreshold: 2, regionQuorum: 2 } },
	monitors: [
		{
			id: "web",
			name: "Web",
			type: "http",
			target: "https://web.example.test/health",
			http: { headers: { "x-api-key": "secret:WEB_KEY" } },
		},
	],
};

/** The text of each Telegram message that the Worker sent. */
let sent: string[];
let webStatus: number;

beforeEach(async () => {
	sent = [];
	webStatus = 200;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		if (req.url === "https://www.cloudflare.com/cdn-cgi/trace") return new Response("colo=TST\n");
		if (req.url === "https://web.example.test/health") {
			expect(req.headers.get("x-api-key")).toBe("test-header-value");
			return new Response("x", { status: webStatus });
		}
		if (req.url.startsWith("https://api.telegram.org/bottest-bot/sendMessage")) {
			sent.push((await req.json<{ text: string }>()).text);
			return new Response("{}");
		}
		throw new Error(`unexpected fetch: ${req.url}`);
	});
	await env.CONFIG.put("config", JSON.stringify(config));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await env.CONFIG.delete("config");
	await reset();
});

const run = () => worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "* * * * *" }), env);

describe("cron run", () => {
	it("checks each region and alerts on the second failed run", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await run();
		const line = JSON.parse(log.mock.calls[0][0] as string);
		expect(line.missing).toEqual([]);
		expect(line.results.map((r: { region: string; ok: boolean }) => [r.region, r.ok])).toEqual([
			["weur", true],
			["eeur", true],
			["enam", true],
		]);

		webStatus = 503;
		await run();
		expect(sent).toEqual([]);
		await run();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatch(/^🔴 DOWN Web \(web\.example\.test\)\nweur TST: status 503/);

		webStatus = 200;
		await run();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatch(/^✅ RECOVERED Web/);
	});

	it("ends the run when KV has no config", async () => {
		await env.CONFIG.delete("config");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await run();
		expect(warn).toHaveBeenCalledWith('no config in KV, key "config"');
		expect(fetch).not.toHaveBeenCalled();
	});
});

const TOKEN = "test-status-token";

function status(init: RequestInit = {}, path = "/status") {
	return exports.default.fetch(new Request(`https://uptime.test${path}`, init));
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe("fetch", () => {
	it("answers 404 on each other path", async () => {
		for (const path of ["/", "/status/", "/status.json", "/statusx"]) {
			const res = await status(bearer(TOKEN), path);
			expect(res.status, path).toBe(404);
		}
	});

	it("answers 404 on /status when the token secret is not set", async () => {
		for (const value of [undefined, ""]) {
			const off = { ...env, STATUS_TOKEN: value } as Env;
			const req = new Request("https://uptime.test/status", bearer(TOKEN)) as Parameters<typeof worker.fetch>[0];
			const res = await worker.fetch(req, off);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("not found\n");
		}
	});

	it("answers 401 with no data when the token is missing or wrong", async () => {
		await run();
		const cases: RequestInit[] = [
			{},
			bearer("wrong"),
			bearer(`${TOKEN}x`),
			bearer(TOKEN.replace(/.$/, "X")),
			{ headers: { authorization: TOKEN } },
			{ headers: { authorization: `Basic ${btoa(`user:${TOKEN}`)}` } },
		];
		for (const init of cases) {
			const res = await status(init);
			expect(res.status).toBe(401);
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
			expect(await res.text()).toBe("unauthorized\n");
		}
	});

	it("answers 405 to a method other than GET", async () => {
		for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
			const res = await status({ method, ...bearer(TOKEN) });
			expect(res.status, method).toBe(405);
			expect(res.headers.get("allow")).toBe("GET");
		}
	});

	it("shows null results before the first run", async () => {
		const res = await status(bearer(TOKEN));
		expect(res.status).toBe(200);
		const body = await res.json<Status>();
		expect(body.lastRun).toBeNull();
		expect(body.note).toMatch(/memory only/);
		expect(body.monitors[0].regions.map((r) => r.last)).toEqual([null, null, null]);
	});

	it("shows the state, the fails, and the last result after a cron run", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		webStatus = 503;
		await run();

		const res = await status(bearer(TOKEN));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("content-type")).toMatch(/^application\/json/);
		const body = await res.json<Status>();
		expect(body.lastRun).toBeTypeOf("number");
		expect(body.memorySince).toBeLessThanOrEqual(body.lastRun!);
		expect(body.probes).toEqual([
			{ region: "weur", misses: 0, alerted: false },
			{ region: "eeur", misses: 0, alerted: false },
			{ region: "enam", misses: 0, alerted: false },
		]);
		expect(body.monitors).toEqual([
			{
				id: "web",
				name: "Web",
				type: "http",
				target: "https://web.example.test/health",
				state: "up",
				since: null,
				regions: ["weur", "eeur", "enam"].map((region) => ({
					region,
					state: "up",
					fails: 1,
					last: {
						colo: "TST",
						ok: false,
						status: 503,
						error: "status 503, expected 200",
						ms: expect.any(Number),
						at: expect.any(Number),
					},
				})),
			},
		]);

		await run();
		const after = await (await status(bearer(TOKEN))).json<Status>();
		expect(after.monitors[0].state).toBe("down");
		expect(after.monitors[0].since).toBeTypeOf("number");
		expect(after.monitors[0].regions.map((r) => [r.state, r.fails])).toEqual([
			["down", 2],
			["down", 2],
			["down", 2],
		]);
	});

	it("shows no secret value", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await run();
		const body = await (await status(bearer(TOKEN))).text();
		for (const secret of ["test-header-value", "WEB_KEY", "x-api-key", TOKEN, "test-bot"]) {
			expect(body).not.toContain(secret);
		}
	});

	it("answers 503 when KV has no config", async () => {
		await env.CONFIG.delete("config");
		const res = await status(bearer(TOKEN));
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: 'no config in KV, key "config"' });
	});
});
