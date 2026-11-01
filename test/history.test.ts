import { createScheduledController, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Result } from "../src/config";
import { MAX_ERROR, writeHistory } from "../src/history";
import worker from "../src/index";

const config: Config = {
	defaults: { regions: ["weur", "eeur", "enam"], interval: 1, timeout: 1000, alert: { failThreshold: 2, regionQuorum: 2 } },
	monitors: [{ id: "web", name: "Web", type: "http", target: "https://web.example.test/health" }],
};

/** Each data point that the fake dataset got. */
let points: AnalyticsEngineDataPoint[];
/** A function that throws makes the write fail. */
let onWrite: (p: AnalyticsEngineDataPoint) => void;
let errors: ReturnType<typeof vi.spyOn>;

const dataset = {
	writeDataPoint: (p: AnalyticsEngineDataPoint) => {
		onWrite(p);
		points.push(p);
	},
} as AnalyticsEngineDataset;

const result = (r: Partial<Result>): Result => ({ id: "web", region: "weur", colo: "LHR", ok: true, status: 200, ms: 95, at: 0, ...r });

beforeEach(() => {
	points = [];
	onWrite = () => {};
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("writeHistory", () => {
	it("writes one point for each result, in the schema order", () => {
		writeHistory({ HISTORY: dataset }, [
			result({}),
			result({ region: "enam", colo: "EWR", ok: false, status: 503, ms: 120, error: "status 503, expected 200" }),
		]);
		expect(points).toEqual([
			{ indexes: ["web"], blobs: ["weur", "LHR", ""], doubles: [95, 1, 200] },
			{ indexes: ["web"], blobs: ["enam", "EWR", "status 503, expected 200"], doubles: [120, 0, 503] },
		]);
	});

	it("writes status 0 for a check with no status", () => {
		writeHistory({ HISTORY: dataset }, [result({ ok: false, status: undefined, ms: 10000, error: "timeout after 10000 ms" })]);
		expect(points[0].doubles).toEqual([10000, 0, 0]);
	});

	it("cuts a long error text", () => {
		writeHistory({ HISTORY: dataset }, [result({ ok: false, error: "x".repeat(1000) })]);
		expect(points[0].blobs?.[2]).toHaveLength(MAX_ERROR);
	});

	it("does nothing with no binding", () => {
		expect(() => writeHistory({}, [result({})])).not.toThrow();
	});

	it("writes the other points when one write throws", () => {
		onWrite = (p) => {
			if (p.blobs?.[0] === "weur") throw new Error("limit");
		};
		writeHistory({ HISTORY: dataset }, [result({}), result({ region: "eeur" })]);
		expect(points.map((p) => p.blobs?.[0])).toEqual(["eeur"]);
		expect(errors).toHaveBeenCalledOnce();
	});
});

describe("cron run", () => {
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
		vi.spyOn(console, "log").mockImplementation(() => {});
		await env.CONFIG.put("config", JSON.stringify(config));
	});

	afterEach(async () => {
		await env.CONFIG.delete("config");
		await reset();
	});

	const run = (e: Env) => worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "* * * * *" }), e);

	it("writes one point for each region", async () => {
		await run({ ...env, HISTORY: dataset });
		expect(points.map((p) => p.blobs?.[0]).sort()).toEqual(["eeur", "enam", "weur"]);
		expect(points.every((p) => p.indexes?.[0] === "web" && p.blobs?.[1] === "TST" && p.doubles?.[1] === 1)).toBe(true);
	});

	it("sends the alert when each history write throws", async () => {
		webStatus = 503;
		onWrite = () => {
			throw new Error("limit");
		};
		const e = { ...env, HISTORY: dataset };
		await run(e);
		await run(e);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatch(/DOWN Web/);
	});
});
