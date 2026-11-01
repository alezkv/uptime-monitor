/** The name of the check in the `CHECKS` secret of the `dms` Worker. */
export const HEARTBEAT_CHECK = "uptime-monitor";

/** The `dms` Worker gets the ping only through the service binding. The host part is not used. */
const PING_URL = `https://dms/ping/${HEARTBEAT_CHECK}`;

/**
 * Pings the `dms` Worker after a full cron run. If `dms` gets no ping in time, it sends
 * a Telegram alert. Thus a stopped monitor also gives an alert.
 *
 * The heartbeat is optional. If the binding or the token is missing, it does nothing.
 * It never throws, so a failed ping cannot stop the run or the alerts.
 */
export async function heartbeat(env: Partial<Pick<Env, "DMS" | "DMS_PING_TOKEN">>): Promise<void> {
	if (!env.DMS || !env.DMS_PING_TOKEN) return;
	try {
		const res = await env.DMS.fetch(PING_URL, {
			method: "POST",
			headers: { authorization: `Bearer ${env.DMS_PING_TOKEN}` },
			signal: AbortSignal.timeout(10_000),
		});
		// Read the body, so that the runtime can close the connection.
		const body = await res.text();
		if (!res.ok) console.error(`heartbeat failed: ${res.status} ${body.trim()}`);
	} catch (err) {
		console.error("heartbeat failed", err);
	}
}
