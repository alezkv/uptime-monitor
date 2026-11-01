// Secrets. Set them with `wrangler secret put`. `wrangler types` does not see them.
interface Secrets {
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_CHAT_ID: string;
	/** The bearer token of GET /status. With no value, the route gives 404. */
	STATUS_TOKEN?: string;
}
interface Env extends Secrets {}
declare namespace Cloudflare {
	interface Env extends Secrets {}
}
