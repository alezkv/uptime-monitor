import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Phase 5 replaces this file with the real tests.
describe("skeleton", () => {
	it("answers 404 on fetch", async () => {
		const res = await exports.default.fetch("https://uptime.test/");
		expect(res.status).toBe(404);
	});
});
