import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config";
import worker from "../src/index";

const valid = {
	defaults: { regions: ["weur", "eeur"], interval: 1, timeout: 10000, alert: { failThreshold: 2, regionQuorum: 2 } },
	monitors: [
		{ id: "web", name: "Web", type: "http", target: "https://example.test/", http: { expectStatus: [200, 302] } },
		{ id: "imaps", name: "IMAPS", type: "tcp", target: "mail.example.test:993", tcp: { tls: true }, interval: 5 },
	],
};

/** `valid` with the first monitor changed. */
function withMonitor(change: Record<string, unknown>) {
	return { ...valid, monitors: [{ ...valid.monitors[0], ...change }, valid.monitors[1]] };
}

function error(value: unknown): string {
	const parsed = parseConfig(value);
	if (parsed.ok) throw new Error("expected an error");
	return parsed.error;
}

describe("schema", () => {
	it("accepts a valid config", () => {
		expect(parseConfig(valid)).toEqual({ ok: true, config: valid });
	});

	it("rejects an unknown region", () => {
		expect(error({ ...valid, defaults: { ...valid.defaults, regions: ["mars"] } })).toMatch("defaults.regions[0]");
	});

	it("rejects a misspelled field", () => {
		expect(error(withMonitor({ http: { expect_status: [200] } }))).toMatch('Unrecognized key: "expect_status"');
	});

	it("rejects a duplicate id", () => {
		const config = { ...valid, monitors: [valid.monitors[0], { ...valid.monitors[1], id: "web" }] };
		expect(error(config)).toMatch("duplicate id web");
	});

	it("rejects a failThreshold or a regionQuorum of 0", () => {
		expect(error(withMonitor({ alert: { failThreshold: 0 } }))).toMatch("monitors[0].alert.failThreshold");
		expect(error(withMonitor({ alert: { regionQuorum: 0 } }))).toMatch("monitors[0].alert.regionQuorum");
	});

	it("rejects a target that does not match the type", () => {
		expect(error(withMonitor({ target: "example.test:443" }))).toMatch("expected an http or https URL");
		expect(error(withMonitor({ type: "tcp", http: undefined, target: "https://example.test/" }))).toMatch(
			"expected host:port",
		);
	});

	it("rejects a header that sends a Telegram secret", () => {
		const config = withMonitor({ http: { headers: { authorization: "secret:TELEGRAM_BOT_TOKEN" } } });
		expect(error(config)).toMatch("monitors[0].http.headers.authorization");
	});

	it("rejects a header that sends the heartbeat token", () => {
		const config = withMonitor({ http: { headers: { authorization: "secret:DMS_PING_TOKEN" } } });
		expect(error(config)).toMatch("monitors[0].http.headers.authorization");
	});
});

describe("cron handler", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await env.CONFIG.delete("config");
	});

	async function run() {
		await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "* * * * *" }), env);
	}

	it("ends the run with no Durable Object call when the config is not valid", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const probe = vi.spyOn(env.PROBE, "getByName");
		const state = vi.spyOn(env.STATE, "getByName");
		await env.CONFIG.put("config", JSON.stringify(withMonitor({ interval: 0 })));
		await run();
		expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^config in KV is not valid:\n.*monitors\[0\]\.interval/s));
		expect(probe).not.toHaveBeenCalled();
		expect(state).not.toHaveBeenCalled();
	});

	it("ends the run when the config is not JSON", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const probe = vi.spyOn(env.PROBE, "getByName");
		await env.CONFIG.put("config", "{");
		await run();
		expect(errors).toHaveBeenCalledWith("config in KV is not valid JSON");
		expect(probe).not.toHaveBeenCalled();
	});
});
