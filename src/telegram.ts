/**
 * Sends one Telegram message. Throws if Telegram does not accept it, so that
 * the caller keeps the old state and the next run tries again.
 */
export async function notify(env: Env, text: string): Promise<void> {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		// The URL holds the bot token, so the error message must not include it.
		throw new Error(`telegram sendMessage: ${res.status} ${await res.text()}`);
	}
}
