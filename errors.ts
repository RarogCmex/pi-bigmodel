/**
 * Error normalization for the BigModel gateway.
 *
 * Three rewrites, all guarded to this provider and applied only to error-stopped
 * assistant messages. Each one exists to reach machinery pi already has:
 *
 *  1. Overflow phrasing → `context_length_exceeded:` so pi's auto-compaction
 *     kicks in. Live 2026-10-09: an oversized prompt on `glm-4.5-flash` is
 *     rejected with HTTP 400 `{"code":"1261","message":"Prompt exceeds max
 *     length"}` — that exact wording is already in pi-ai's own overflow catalog
 *     (`pi-ai/dist/utils/overflow.js`, "z.ai CN endpoint token overflow"), so
 *     pi compacts even without us. We still normalize, because the published
 *     error table lists the Chinese form (`Prompt 超长`) for the same code and
 *     nothing in pi matches that.
 *
 *  2. The Chinese-only 401 family into an actionable hint with the key-page
 *     link. Live 2026-10-09 body: `401: {"code":"1000","message":"身份验证失败。"}`
 *     — note this is NOT the wording this file used to quote
 *     (令牌已过期或验证不正确, code 1003); both are matched now.
 *
 *  3. HTTP 429 codes that are permanent, not throttling → an actionable message
 *     that also stops pi from retrying. BigModel answers "account has no money"
 *     with 429/1113, and pi's retry classifier is text-based: `"429"` is in its
 *     RETRYABLE list, so an empty balance burns the whole retry budget
 *     (measured 2026-10-09: 16 s of retries in print mode with default
 *     settings, and this machine runs `retry.maxRetries: 10`). pi checks its
 *     NON_RETRYABLE deny-list first (`pi-ai/dist/utils/retry.js`), and that list
 *     contains `billing` and `quota exceeded` — so the rewrite carries the code
 *     in a bracketed tag like `[billing 1113]`. The tag is not decoration: it is
 *     the only supported way for an extension to make an error non-retryable,
 *     and `test/errors.test.ts` asserts it against pi's real classifier.
 *
 * Codes come from https://docs.bigmodel.cn/cn/api/api-code.md (read 2026-10-09)
 * and from the bodies recorded in `research/evidence-2026-10-09.json`.
 */

const CONTEXT_OVERFLOW_RE =
	/context_length_exceeded|exceed(?:s|ed)?[^.\n]{0,60}context|Input tokens exceed|exceed max message tokens|Prompt exceeds max length|Total tokens of image and text exceed|Range of (?:input|prompt) length|输入.{0,20}超出|超出.{0,30}(?:上下文|长度|限制)|上下文.{0,12}(?:超|限制)|超过.{0,20}(?:最大|长度)|超长/i;

const RATE_LIMIT_RE =
	/rate.?limit|too many requests|requests per (second|minute)|\bquota\b|\b429\b|频率|限流|过于频繁/i;

/** Auth-related messages worth clarifying (401/403 family, incl. the Chinese wording). */
const AUTH_RE = /\b40[13]\b|令牌|unauthorized|forbidden|无效|过期|鉴权|身份验证|验证失败|未收到\s*Authentication|认证/i;

/** Business code inside the JSON body pi surfaces (`429: {"code":"1113",…}`). */
const CODE_RE = /"code"\s*:\s*"?(\d{3,4})"?/;

/**
 * The Responses surface (`/api/v1/responses`) reports OpenAI-style string codes
 * instead of numbers: `insufficient_quota`, `overloaded`, `rate_limit_exceeded`,
 * `model_not_found`, `invalid_request`, `context_length_exceeded` (all recorded
 * live 2026-10-09). Only the billing one changes what pi should do; the rest are
 * either transient (pi retries them on its own) or not ours to reinterpret.
 */
const RESPONSES_LIMIT_CODES: Readonly<Record<string, LimitKind>> = {
	insufficient_quota: "balance",
	insufficient_balance: "balance",
	billing_error: "balance",
};

/** String codes that must stay retryable — never let the wording fallback catch them. */
const RESPONSES_TRANSIENT_CODES = /"?(?:overloaded|rate_limit_exceeded|server_busy|service_unavailable|timeout)"?/i;

/**
 * 429 codes that will not fix themselves by waiting.
 *
 * Deliberately absent — transient throttles that SHOULD keep retrying:
 *   1302 账户速率限制, 1305 该模型当前访问量过大, 1313 公平使用策略限频.
 */
export type LimitKind = "balance" | "quota" | "plan";

const PERMANENT_LIMIT_CODES: Readonly<Record<string, LimitKind>> = {
	1113: "balance", // 您的账户已欠费 / live: 余额不足或无可用资源包,请充值。
	1308: "quota", // 已达到 N 单位 的使用上限，限额将在 next_flush_time 重置
	1309: "plan", // GLM Coding Plan 套餐已到期
	1310: "quota", // 每周/每月使用上限
	1311: "plan", // 当前订阅套餐暂未开放该模型权限
	1314: "plan", // 企业套餐已失效
	1315: "plan", // 该 API Key 仅限企业编程套餐场景使用
	1316: "quota", // 5 小时上限 + 主账号余额不足，无法超额按量付费
	1317: "quota", // 7 天上限 + 主账号余额不足
	1318: "quota", // 5 小时上限 + 子账号月消费上限
	1319: "quota", // 7 天上限 + 子账号月消费上限
	1320: "quota", // 5 小时上限 + 企业级月消费上限
	1321: "quota", // 7 天上限 + 企业级月消费上限
};

/** Wording fallback for gateways/proxies that drop the numeric code. */
const PERMANENT_LIMIT_WORDS: readonly [RegExp, LimitKind][] = [
	[/欠费|余额不足|请充值|无可用资源包/, "balance"],
	[/使用上限|限额将在|消费上限/, "quota"],
	[/套餐(?:已到期|已失效|暂未开放)|仅限企业编程套餐/, "plan"],
];

/**
 * Maps gateway overflow errors onto pi's `context_length_exceeded` marker so
 * auto-compaction kicks in. Returns the rewritten message text, or null when
 * the error is not an overflow (rate limits must never trigger compaction).
 */
export function normalizeOverflowError(errorMessage: string): string | null {
	if (!errorMessage) return null;
	// Idempotent, and never redundant: pi matches /context[_ ]length[_ ]exceeded/i
	// ANYWHERE in the message, so a body that already carries the marker (the
	// Responses surface returns it as the error `code`) needs no rewrite.
	if (errorMessage.includes("context_length_exceeded")) return null;
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
/** Where the balance/plan state and the top-up button live. */
export const BILLING_URL = "https://bigmodel.cn/finance";
/** Coding Plan overview — the product a `plan`-kind code refers to. */
export const CODING_PLAN_URL = "https://bigmodel.cn/coding-plan/personal/overview";

/**
 * Rewrites the opaque/Chinese auth failure into a readable, actionable message.
 * Always keeps the original text so nothing is hidden from the user.
 */
export function clarifyErrorMessage(errorMessage: string): string | undefined {
	if (!errorMessage) return undefined;
	if (errorMessage.startsWith("BigModel (Zhipu AI):")) return undefined; // idempotent
	if (!AUTH_RE.test(errorMessage)) return undefined;
	return (
		`BigModel (Zhipu AI): ключ API недействителен, отозван или истёк (либо не передан). ` +
		`Проверьте ключ: ${API_KEYS_URL} — затем выполните \`/login bigmodel\` ` +
		`или обновите \`BIGMODEL_API_KEY\`. Исходная ошибка: ${errorMessage}`
	);
}

/**
 * Which permanent-limit class an error belongs to, or undefined when the code is
 * transient (1302/1305/1313) or unrelated. Code first, wording as fallback.
 */
export function classifyLimitError(errorMessage: string): { kind: LimitKind; code?: string } | undefined {
	if (!errorMessage) return undefined;
	if (errorMessage.includes("BigModel (Zhipu AI):")) return undefined; // idempotent: already rewritten
	const stringCode = /"?(?:code|type)"?\s*:\s*"([a-z_]+)"/i.exec(errorMessage)?.[1];
	if (stringCode) {
		if (RESPONSES_TRANSIENT_CODES.test(stringCode)) return undefined;
		const mapped = RESPONSES_LIMIT_CODES[stringCode];
		if (mapped) return { kind: mapped, code: stringCode };
	}
	const code = CODE_RE.exec(errorMessage)?.[1];
	if (code && PERMANENT_LIMIT_CODES[code]) return { kind: PERMANENT_LIMIT_CODES[code], code };
	if (code && !PERMANENT_LIMIT_CODES[code]) {
		// A known-but-transient code (1302/1305/1313) must stay retryable: do not
		// let the wording fallback override an explicit transient code.
		if (/^(1302|1305|1313)$/.test(code)) return undefined;
	}
	for (const [re, kind] of PERMANENT_LIMIT_WORDS) {
		if (re.test(errorMessage)) return { kind, code };
	}
	return undefined;
}

/** pi's non-retryable deny-list token for each class (`utils/retry.js`). */
const DENY_LIST_TAG: Record<LimitKind, string> = {
	balance: "billing",
	quota: "quota exceeded",
	plan: "billing",
};

const LIMIT_ADVICE: Record<LimitKind, string> = {
	balance:
		`на аккаунте закончились деньги и нет ресурсных пакетов. Пополните баланс или подключите пакет: ` +
		`${BILLING_URL}. Бесплатные модели (glm-4.7-flash, glm-4.5-flash, glm-4-flash-250414, glm-4.6v-flash, ` +
		`glm-4.1v-thinking-flash) продолжают работать и без баланса.`,
	quota:
		`достигнут предел использования (лимит сбросится в указанное сервером время). Повторные запросы до сброса ` +
		`не помогут; при необходимости возьмите модель дешевле или другой ключ.`,
	plan:
		`ключ или подписка не дают доступа к этой модели. Ключи GLM Coding Plan работают на эндпоинте ` +
		`/api/coding/paas/v4 (в pi это встроенный провайдер zai-coding-cn), а этот плагин использует стандартный ` +
		`/api/paas/v4 с оплатой по факту: ${CODING_PLAN_URL}.`,
};

/**
 * Rewrites a permanent 429 into an actionable message and — via the bracketed
 * deny-list tag — into a non-retryable one. Returns undefined for transient
 * throttles so pi keeps retrying them. The original text always survives.
 */
export function clarifyLimitErrorMessage(errorMessage: string): string | undefined {
	const limit = classifyLimitError(errorMessage);
	if (!limit) return undefined;
	const tag = `[${DENY_LIST_TAG[limit.kind]}${limit.code ? ` ${limit.code}` : ""}]`;
	return `BigModel (Zhipu AI): ${LIMIT_ADVICE[limit.kind]} ${tag} Исходная ошибка: ${errorMessage}`;
}

/** Short persistent-transcript version of the same hint (TUI only, see index.ts). */
export function limitHelpEntryContent(kind: LimitKind): string {
	const suffix =
		kind === "plan"
			? `Ключи Coding Plan относятся к другому эндпоинту: ${CODING_PLAN_URL}`
			: `Баланс и лимиты: ${BILLING_URL} — ключ: ${API_KEYS_URL}`;
	return `BigModel (Zhipu AI): запрос отклонён не из-за нагрузки, повторные попытки не помогут. ${suffix}`;
}

/**
 * HTTP status for a documented business code (`cn/api/api-code.md`, read
 * 2026-10-09). Used only to re-status the Responses surface's in-band errors so
 * pi sees the same status it would have seen on completions.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
	1000: 401,
	1001: 401,
	1003: 401,
	1005: 401,
	1113: 429,
	1200: 500,
	1220: 403,
	1230: 500,
	1234: 500,
	1302: 429,
	1305: 429,
	1308: 429,
	1309: 429,
	1310: 429,
	1311: 429,
	1313: 429,
	1314: 429,
	1315: 429,
	1316: 429,
	1317: 429,
	1318: 429,
	1319: 429,
	1320: 429,
	1321: 429,
};

/** The in-band error body: `{"code":1000,"msg":"身份验证失败。","success":false}`. */
export interface InBandError {
	code: number;
	msg: string;
}

/**
 * Parse the Responses surface's in-band error body, or return undefined when the
 * payload is anything else (a successful `{"object":"response",…}`, an SSE
 * stream, HTML from a proxy, truncated JSON).
 */
export function parseInBandError(body: string): InBandError | undefined {
	const trimmed = body.trim();
	if (!trimmed.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const candidate = parsed as { code?: unknown; msg?: unknown; message?: unknown; success?: unknown };
	if (candidate.success !== false) return undefined;
	if (typeof candidate.code !== "number") return undefined;
	const msg = candidate.msg ?? candidate.message;
	if (typeof msg !== "string" || !msg) return undefined;
	return { code: candidate.code, msg };
}

/**
 * Turn an in-band error into the HTTP error pi expects.
 *
 * The Responses surface answers a bad or missing credential with **HTTP 200** and
 * `{"code":1000,"msg":"身份验证失败。","success":false}` (measured 2026-10-09 for a
 * revoked key, a garbage key and no `Authorization` header at all). pi streams,
 * so it looks for SSE, finds a JSON document, and surfaces
 * `"OpenAI Responses stream ended before a terminal response event"` — a message
 * that is in pi's RETRYABLE list, so a dead key retries for the whole budget and
 * the user is told nothing about their key.
 *
 * The wrapper re-emits the body as the same envelope every other surface uses,
 * with the documented HTTP status, so the ordinary error path and the rewrites in
 * this file handle it: `401: {"code":"1000","message":"身份验证失败。"}`.
 *
 * Deliberately narrow — only HTTP 200, only a JSON content type, only a body that
 * parses as `{code:number, msg:string, success:false}`. Everything else is
 * returned untouched with its stream intact (`clone()` before reading).
 */
export async function remediateInBandResponse(response: Response): Promise<Response> {
	if (response.status !== 200) return response;
	const contentType = response.headers.get("content-type") ?? "";
	if (!/application\/json/i.test(contentType)) return response;
	let body: string;
	try {
		body = await response.clone().text();
	} catch {
		return response;
	}
	const inBand = parseInBandError(body);
	if (!inBand) return response;
	const status = STATUS_BY_CODE[String(inBand.code)] ?? 400;
	const envelope = JSON.stringify({ error: { code: String(inBand.code), message: inBand.msg } });
	// No statusText: an HTTP reason phrase must be Latin-1, and the gateway's
	// wording is Chinese — undici throws on it. The message travels in the body,
	// which is where pi reads it from anyway.
	return new Response(envelope, {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}
