// Queries the check history in Workers Analytics Engine through the SQL API.
//
//   node scripts/history.ts <query> [hours]
//
// The script reads two environment variables. Do not put them in a file in the repository.
//   CF_ACCOUNT_ID  the account ID. `npx wrangler whoami` shows it.
//   CF_AE_TOKEN    an API token with the permission Account > Account Analytics > Read.
//
// Each row stands for `_sample_interval` real points, so each query weights with it.

// An ES module, so that the file can use a top-level await.
export {};

const TABLE = "uptime_results";

const QUERIES: Record<string, { about: string; hours: number; sql: (hours: number) => string }> = {
	uptime: {
		about: "uptime % of the checks, for each monitor",
		hours: 24 * 30,
		sql: (h) => `SELECT index1 AS monitor,
  100 * sum(double2 * _sample_interval) / sum(_sample_interval) AS uptime_pct,
  sum(_sample_interval) AS checks
FROM ${TABLE}
WHERE timestamp > NOW() - INTERVAL '${h}' HOUR
GROUP BY monitor
ORDER BY uptime_pct, monitor`,
	},
	latency: {
		about: "p50 and p95 latency of the passed checks, for each monitor and region",
		hours: 24,
		sql: (h) => `SELECT index1 AS monitor, blob1 AS region,
  quantileExactWeighted(0.50)(double1, _sample_interval) AS p50_ms,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms,
  sum(_sample_interval) AS checks
FROM ${TABLE}
WHERE timestamp > NOW() - INTERVAL '${h}' HOUR AND double2 = 1
GROUP BY monitor, region
ORDER BY monitor, region`,
	},
	failures: {
		about: "the last 100 failed checks",
		hours: 24,
		sql: (h) => `SELECT timestamp, index1 AS monitor, blob1 AS region, blob2 AS colo,
  double3 AS status, blob3 AS error, _sample_interval AS n
FROM ${TABLE}
WHERE timestamp > NOW() - INTERVAL '${h}' HOUR AND double2 = 0
ORDER BY timestamp DESC
LIMIT 100`,
	},
	counts: {
		about: "the number of failed checks, for each monitor and region",
		hours: 24,
		sql: (h) => `SELECT index1 AS monitor, blob1 AS region, sum(_sample_interval) AS failures
FROM ${TABLE}
WHERE timestamp > NOW() - INTERVAL '${h}' HOUR AND double2 = 0
GROUP BY monitor, region
ORDER BY failures DESC`,
	},
	tables: { about: "the tables of the account", hours: 0, sql: () => "SHOW TABLES" },
};

const USAGE = `usage: node scripts/history.ts <query> [hours]

queries:
${Object.entries(QUERIES)
	.map(([name, q]) => `  ${name.padEnd(9)} ${q.about}${q.hours ? ` (default: last ${q.hours} h)` : ""}`)
	.join("\n")}`;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const [name, hoursArg] = process.argv.slice(2);
const query = name ? QUERIES[name] : undefined;
if (!query) fail(USAGE);

const hours = hoursArg === undefined ? query.hours : Number(hoursArg);
if (!Number.isInteger(hours) || hours < 1) fail(`hours must be a whole number of 1 or more, not "${hoursArg}"`);

const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_AE_TOKEN;
if (!account || !token) fail("set CF_ACCOUNT_ID and CF_AE_TOKEN first. See the comment at the top of this file.");

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
	method: "POST",
	headers: { authorization: `Bearer ${token}` },
	// The default answer format is JSON: { meta: [{ name }], data: [{ ... }] }.
	body: query.sql(hours),
});
const body = await res.text();
if (!res.ok) fail(`SQL API: ${res.status}\n${body.trim()}`);

const { meta, data } = JSON.parse(body) as { meta: { name: string }[]; data: Record<string, unknown>[] };
const cell = (v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : String(v ?? ""));
const rows = [meta.map((m) => m.name), ...data.map((row) => meta.map((m) => cell(row[m.name])))];
const widths = meta.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
