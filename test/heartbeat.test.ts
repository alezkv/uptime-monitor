import { createScheduledController, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config";
import { HEARTBEAT_CHECK, heartbeat } from "../src/heartbeat";
import worker from "../src/index";

const config: Config = {
	defaults: { regions: ["weur", "eeur", "enam"], interval: 1, timeout: 1000, alert: { failThreshold: 2, regionQuorum: 2 } },
	monitors: [{ id: "web", name: "Web", type: "http", target: "https://web.example.test/health" }],
};

/** The text of each Telegram message that the Worker sent. */
let sent: string[];
let webStatus: number;
/** Each request that the fake `dms` Worker got. */
let pings: Request[];
/** The answer of the fake `dms` Worker. A function that throws makes the binding call fail. */
let dmsAnswer: () => Response;

const dms = {
	fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
		pings.push(new Request(input, init));
		return dmsAnswer();
	},
} as unknown as Fetcher;

beforeEach(async () => {
	sent = [];
	webStatus = 200;
	pings = [];
	dmsAnswer = () => new Response("ok\n");
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		if (req.url === "https://www.cloudflare.com/cdn-cgi/trace") return new Response("colo=TST\n");
		if (req.url === "https://web.example.test/health") return new Response("x", { status: webStatus });
		if (req.url.startsWith("https://api.telegram.org/bottest-bot/sendMessage")) {
			sent.push((await req.json<{ text: string }>()).text);
			return new Response("{}");
		}
		throw new Error(`unexpected fetch: ${req.url}`);
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	await env.CONFIG.put("config", JSON.stringify(config));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await env.CONFIG.delete("config");
	await reset();
});

/** The test env with the heartbeat configured. */
const configured = () => ({ ...env, DMS: dms, DMS_PING_TOKEN: "dms-token" });

const run = (e: Env) => worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "* * * * *" }), e);

describe("heartbeat", () => {
	it("pings dms after a full run", async () => {
		await run(configured());
		expect(pings).toHaveLength(1);
		const [ping] = pings;
		expect(ping.method).toBe("POST");
		expect(new URL(ping.url).pathname).toBe(`/ping/${HEARTBEAT_CHECK}`);
		expect(ping.headers.get("authorization")).toBe("Bearer dms-token");
	});

	it("pings dms when no monitor is due", async () => {
		await env.CONFIG.put("config", JSON.stringify({ ...config, monitors: [{ ...config.monitors[0], enabled: false }] }));
		await run(configured());
		expect(fetch).not.toHaveBeenCalled();
		expect(pings).toHaveLength(1);
	});

	it("does not ping when the run stops early", async () => {
		await env.CONFIG.put("config", "not json");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await run(configured());
		expect(error).toHaveBeenCalledWith("config in KV is not valid JSON");
		expect(pings).toEqual([]);
	});

	it("does not ping when the token or the binding is missing", async () => {
		await run({ ...configured(), DMS_PING_TOKEN: undefined });
		await run({ ...configured(), DMS: undefined } as unknown as Env);
		// The test env has the binding from wrangler.toml, but no token.
		await run(env);
		expect(pings).toEqual([]);
	});

	it("logs a failed ping and still sends the alerts", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		dmsAnswer = () => {
			throw new Error("dms is not reachable");
		};
		webStatus = 503;
		await run(configured());
		await expect(run(configured())).resolves.toBeUndefined();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatch(/^🔴 DOWN Web/);
		expect(pings).toHaveLength(2);
		expect(error).toHaveBeenCalledWith("heartbeat failed", expect.any(Error));
	});

	it("logs a ping that dms rejects", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		dmsAnswer = () => new Response("unauthorized\n", { status: 401 });
		await expect(heartbeat({ DMS: dms, DMS_PING_TOKEN: "wrong" })).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith("heartbeat failed: 401 unauthorized");
	});
});
