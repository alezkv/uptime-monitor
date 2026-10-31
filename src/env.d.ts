// Secrets. Set them with `wrangler secret put`. `wrangler types` does not see them.
interface Secrets {
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_CHAT_ID: string;
}
interface Env extends Secrets {}
declare namespace Cloudflare {
	interface Env extends Secrets {}
}
