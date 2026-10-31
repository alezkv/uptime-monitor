import { createScheduledController, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config";
import worker from "../src/index";

const config: Config = {
	defaults: { regions: ["weur", "eeur", "enam"], interval: 1, timeout: 1000, alert: { failThreshold: 2, regionQuorum: 2 } },
	monitors: [{ id: "web", name: "Web", type: "http", target: "https://web.example.test/health" }],
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
		if (req.url === "https://web.example.test/health") return new Response("x", { status: webStatus });
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

describe("fetch", () => {
	it("answers 404", async () => {
		const res = await exports.default.fetch("https://uptime.test/");
		expect(res.status).toBe(404);
	});
});
