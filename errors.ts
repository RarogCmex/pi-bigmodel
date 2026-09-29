/**
 * Error normalization for the BigModel gateway.
 *
 * Two rewrites, both guarded to this provider and applied only to
 * error-stopped assistant messages:
 *
 *  1. Overflow phrasing → `context_length_exceeded:` so pi's auto-compaction
 *     kicks in. BigModel reports a rejected oversize prompt as a 4xx with a
 *     `{"error":{"code":"…","message":"…"}}` body; the exact overflow code was
 *     not reproduced live (a >200K-token probe is not worth the spend), so the
 *     matcher is deliberately broad on the documented phrasing family and the
 *     rate-limit guard keeps 429s out.
 *
 *  2. The Chinese-only 401 message ("令牌已过期或验证不正确" = "token expired or
 *     incorrect") into an actionable hint with the key-page link. The body IS
 *     delivered (BigModel uses a standard OpenAI error envelope, so pi-ai
 *     already surfaces `error.message`), so only a translation is needed — the
 *     original text always survives.
 */

const CONTEXT_OVERFLOW_RE =
	/context_length_exceeded|exceed(?:s|ed)?[^.\n]{0,60}context|Input tokens exceed|exceed max message tokens|Total tokens of image and text exceed|Range of (?:input|prompt) length|输入.{0,20}超出|超出.{0,30}(?:上下文|长度|限制)|上下文.{0,12}(?:超|限制)|超过.{0,20}(?:最大|长度)/i;

const RATE_LIMIT_RE =
	/rate.?limit|too many requests|requests per (?:second|minute)|\bquota\b|\b429\b|频率|限流|过于频繁/i;

/** Auth-related messages worth clarifying (401/403 family, incl. the Chinese wording). */
const AUTH_RE = /\b40[13]\b|令牌|unauthorized|forbidden|无效|过期|鉴权/i;

/**
 * Maps gateway overflow errors onto pi's `context_length_exceeded` marker so
 * auto-compaction kicks in. Returns the rewritten message text, or null when
 * the error is not an overflow (rate limits must never trigger compaction).
 */
export function normalizeOverflowError(errorMessage: string): string | null {
	if (!errorMessage) return null;
	if (errorMessage.startsWith("context_length_exceeded")) return null; // idempotent
	if (RATE_LIMIT_RE.test(errorMessage)) return null;
	if (!CONTEXT_OVERFLOW_RE.test(errorMessage)) return null;
	return `context_length_exceeded: ${errorMessage}`;
}

/** True when an error-stopped assistant message looks like a BigModel auth failure. */
export function shouldClarify(message: { errorMessage?: string }): boolean {
	const text = message.errorMessage ?? "";
	if (!text) return false;
	return AUTH_RE.test(text);
}

export const API_KEYS_URL = "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys";

/**
 * Rewrites the opaque/Chinese auth failure into a readable, actionable message.
 * Always keeps the original text so nothing is hidden from the user.
 */
export function clarifyErrorMessage(errorMessage: string): string | undefined {
	if (!errorMessage) return undefined;
	if (!AUTH_RE.test(errorMessage)) return undefined;
	return (
		`BigModel (Zhipu AI): ключ API недействителен, отозван или истёк (либо не передан). ` +
		`Проверьте ключ: ${API_KEYS_URL} — затем выполните \`/login bigmodel\` ` +
		`или обновите \`BIGMODEL_API_KEY\`. Исходная ошибка: ${errorMessage}`
	);
}
