import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Region, Result } from "../src/config";
import { duration, line, PROBE_MISS_LIMIT } from "../src/state";

const REGIONS: Region[] = ["weur", "eeur", "enam"];
const COLO: Record<string, string> = { weur: "FRA", eeur: "WAW", enam: "EWR" };

const config: Config = {
	defaults: { regions: REGIONS, interval: 1, timeout: 10000, alert: { failThreshold: 2, regionQuorum: 2 } },
	monitors: [{ id: "auth", name: "Authelia", type: "http", target: "https://auth.example.test/api/health" }],
};

/** The text of each Telegram message that the Worker sent. */
let sent: string[];
let telegramStatus: number;

beforeEach(() => {
	sent = [];
	telegramStatus = 200;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		if (!req.url.startsWith("https://api.telegram.org/bottest-bot/sendMessage")) {
			throw new Error(`unexpected fetch: ${req.url}`);
		}
		const body = await req.json<{ chat_id: string; text: string }>();
		expect(body.chat_id).toBe("42");
		if (telegramStatus === 200) sent.push(body.text);
		return new Response("{}", { status: telegramStatus });
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	// Delete the Durable Object storage. The plugin does not isolate it between tests.
	await reset();
});

const stub = () => env.STATE.getByName("state");

/** One result for each region of "auth". The regions in `failing` fail with a 503. */
function results(failing: Region[] = [], regions: Region[] = REGIONS): Result[] {
	return regions.map((region) => {
		const fail = failing.includes(region);
		return {
			id: "auth",
			region,
			colo: COLO[region],
			ok: !fail,
			status: fail ? 503 : 200,
			error: fail ? "status 503, expected 200" : undefined,
			ms: 120,
			at: Date.now(),
		};
	});
}

function record(failing: Region[] = [], c: Config = config) {
	return stub().record(c, results(failing), []);
}

function rows(table: "fails" | "down" | "probes"): Promise<number> {
	return runInDurableObject(stub(), (_, state) => {
		return state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n;
	});
}

describe("alerts", () => {
	it("writes no row when all regions are up", async () => {
		await record();
		await record();
		expect(await rows("fails")).toBe(0);
		expect(await rows("down")).toBe(0);
		expect(sent).toEqual([]);
	});

	it("sends no alert when one region fails", async () => {
		for (let i = 0; i < 5; i++) await record(["weur"]);
		expect(sent).toEqual([]);
	});

	it("sends one down alert when two regions fail two times", async () => {
		await record(["weur", "eeur"]);
		expect(sent).toEqual([]);
		await record(["weur", "eeur"]);
		expect(sent).toEqual([
			[
				"🔴 DOWN Authelia (auth.example.test)",
				"weur FRA: status 503, expected 200 (120 ms)",
				"eeur WAW: status 503, expected 200 (120 ms)",
				"enam EWR: ok (120 ms)",
			].join("\n"),
		]);
		await record(["weur", "eeur"]);
		expect(sent).toHaveLength(1);
	});

	it("stops the count at failThreshold, so an outage writes no more rows", async () => {
		await record(["weur", "eeur"]);
		await record(["weur", "eeur"]);
		const counts = await runInDurableObject(stub(), (_, state) =>
			state.storage.sql.exec<{ n: number }>("SELECT n FROM fails").toArray().map((r) => r.n),
		);
		await record(["weur", "eeur"]);
		const again = await runInDurableObject(stub(), (_, state) =>
			state.storage.sql.exec<{ n: number }>("SELECT n FROM fails").toArray().map((r) => r.n),
		);
		expect(counts).toEqual([2, 2]);
		expect(again).toEqual([2, 2]);
	});

	it("sends one recovered alert when the regions recover", async () => {
		await record(["weur", "eeur"]);
		await record(["weur", "eeur"]);
		await record(["weur"]);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatch(/^✅ RECOVERED Authelia \(auth\.example\.test\) after 1 min\n/);
		await record();
		expect(sent).toHaveLength(2);
		expect(await rows("down")).toBe(0);
		expect(await rows("fails")).toBe(0);
	});

	it("sends the alert again on the next run when Telegram fails", async () => {
		await record(["weur", "eeur"]);
		telegramStatus = 500;
		await record(["weur", "eeur"]);
		expect(sent).toEqual([]);
		expect(await rows("down")).toBe(0);

		telegramStatus = 200;
		await record(["weur", "eeur"]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatch(/^🔴 DOWN/);
	});

	it("uses all regions when the monitor has fewer regions than the quorum", async () => {
		const one: Config = { ...config, monitors: [{ ...config.monitors[0], regions: ["weur"] }] };
		await stub().record(one, results(["weur"], ["weur"]), []);
		await stub().record(one, results(["weur"], ["weur"]), []);
		expect(sent).toEqual(["🔴 DOWN Authelia (auth.example.test)\nweur FRA: status 503, expected 200 (120 ms)"]);
	});

	it("deletes the state of a monitor that is no longer in the config", async () => {
		await record(["weur", "eeur"]);
		await record(["weur", "eeur"]);
		expect(await rows("down")).toBe(1);
		await stub().record({ ...config, monitors: [] }, [], []);
		expect(await rows("fails")).toBe(0);
		expect(await rows("down")).toBe(0);
		expect(sent).toHaveLength(1);
	});
});

describe("probe regions", () => {
	const missWeur = () => stub().record(config, results([], ["eeur", "enam"]), ["weur"]);

	it("does not count a failed Probe call as a failure of the monitor", async () => {
		for (let i = 0; i < 3; i++) await stub().record(config, results(["eeur"], ["eeur", "enam"]), ["weur"]);
		expect(sent).toEqual([]);
	});

	it(`sends one alert after ${PROBE_MISS_LIMIT} runs with no result, and one when the region works again`, async () => {
		for (let i = 0; i < PROBE_MISS_LIMIT - 1; i++) await missWeur();
		expect(sent).toEqual([]);
		await missWeur();
		expect(sent).toEqual([`⚠️ PROBE weur failed in ${PROBE_MISS_LIMIT} runs in a row. Its monitors are not checked from weur.`]);
		await missWeur();
		expect(sent).toHaveLength(1);

		await record();
		expect(sent).toEqual([sent[0], "✅ PROBE weur works again."]);
		expect(await rows("probes")).toBe(0);
	});

	it("forgets a short Probe failure with no alert", async () => {
		await missWeur();
		expect(await rows("probes")).toBe(1);
		await record();
		expect(await rows("probes")).toBe(0);
		expect(sent).toEqual([]);
	});
});

describe("text", () => {
	it("formats a duration", () => {
		expect(duration(10_000)).toBe("1 min");
		expect(duration(12 * 60_000)).toBe("12 min");
		expect(duration((3 * 60 + 5) * 60_000)).toBe("3 h 5 min");
		expect(duration((50 * 60 + 10) * 60_000)).toBe("2 d 2 h");
	});

	it("formats a timeout and a missing result", () => {
		const r: Result = { id: "a", region: "weur", colo: "FRA", ok: false, error: "timeout after 10000 ms", ms: 10003, at: 0 };
		expect(line("weur", r)).toBe("weur FRA: timeout after 10000 ms");
		expect(line("eeur", undefined)).toBe("eeur: no result");
	});
});
