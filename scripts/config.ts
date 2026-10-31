// Validates a monitors YAML file and pushes it to the "config" key in KV.
//
//   node scripts/config.ts check <file>
//   node scripts/config.ts push <file> [--local]
//
// Node.js 22.18 and later runs this file with no build step.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { type Config, parseConfig } from "../src/config.ts";

const USAGE = "usage: node scripts/config.ts check <file>\n       node scripts/config.ts push <file> [--local]";

function load(file: string): Config {
	let value: unknown;
	try {
		value = parse(readFileSync(file, "utf8"), { prettyErrors: true });
	} catch (err) {
		fail(`${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const parsed = parseConfig(value);
	if (!parsed.ok) fail(`${file} is not valid:\n${parsed.error}`);
	return parsed.config;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function summary(config: Config): string {
	const enabled = config.monitors.filter((m) => m.enabled !== false).length;
	return `${config.monitors.length} monitors, ${enabled} enabled`;
}

const [command, file, ...flags] = process.argv.slice(2);
const unknown = flags.filter((f) => f !== "--local");
if (!file || unknown.length > 0 || (command === "check" && flags.length > 0)) fail(USAGE);

if (command === "check") {
	console.log(`ok: ${summary(load(file))}`);
} else if (command === "push") {
	const config = load(file);
	const where = flags.includes("--local") ? "--local" : "--remote";
	// No shell, so the JSON goes to Wrangler as one argument with no quoting.
	const res = spawnSync("npx", ["wrangler", "kv", "key", "put", "--binding", "CONFIG", "config", JSON.stringify(config), where], {
		stdio: "inherit",
	});
	if (res.error) fail(`wrangler did not start: ${res.error.message}`);
	if (res.status !== 0) process.exit(res.status ?? 1);
	console.log(`pushed (${where.slice(2)}): ${summary(config)}`);
} else {
	fail(USAGE);
}
