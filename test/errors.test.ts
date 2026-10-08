import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	clarifyErrorMessage,
	clarifyLimitErrorMessage,
	classifyLimitError,
	normalizeOverflowError,
	shouldClarify,
} from "../errors.ts";

/**
 * Bodies exactly as pi surfaces them (`formatProviderError` → `"<status>: <body>"`,
 * where the body is the gateway's inner error object). Recorded live on
 * 2026-10-09 — see `research/evidence-2026-10-09.json`.
 */
const LIVE = {
	overflow: '400: {"code":"1261","message":"Prompt exceeds max length"}',
	auth1000: '401: {"code":"1000","message":"身份验证失败。"}',
	balance1113: '429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}',
	modelOverload1305: '429: {"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}',
	forcedThinking1210: '400: {"code":"1210","message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}',
	maxTokens1210: '400: {"code":"1210","message":"max_tokens参数非法：限制数值范围[1,98304]"}',
	modelMissing1211: '400: {"code":"1211","message":"模型不存在，请检查模型代码。"}',
} as const;

/** pi reads the classification off an error-stopped assistant message. */
function errored(errorMessage: string): AssistantMessage {
	return { role: "assistant", stopReason: "error", errorMessage, provider: "bigmodel" } as unknown as AssistantMessage;
}

describe("normalizeOverflowError", () => {
	test("maps English overflow phrasing", () => {
		const out = normalizeOverflowError("400 Input tokens exceed the model context length");
		assert.ok(out?.startsWith("context_length_exceeded"));
		assert.ok(out!.includes("Input tokens"));
	});

	test("maps Chinese overflow phrasing", () => {
		for (const msg of ["输入长度超出限制", "超出上下文长度", "上下文长度超限"]) {
			const out = normalizeOverflowError(msg);
			assert.equal(out, `context_length_exceeded: ${msg}`, msg);
		}
	});

	test("maps the live 1261 body (recorded 2026-10-09)", () => {
		const out = normalizeOverflowError(LIVE.overflow);
		assert.ok(out?.startsWith("context_length_exceeded"), String(out));
		assert.ok(out!.includes("Prompt exceeds max length"));
	});

	test("maps the documented Chinese 1261 wording too", () => {
		// docs.bigmodel.cn/cn/api/api-code.md lists 1261 as 「Prompt 超长」; the live
		// gateway answered in English. Both must reach pi's compaction marker.
		assert.equal(normalizeOverflowError('400: {"code":"1261","message":"Prompt 超长"}'), 'context_length_exceeded: 400: {"code":"1261","message":"Prompt 超长"}');
	});

	test("pi's own classifier already recognises the live body", () => {
		// pi-ai lists "Prompt exceeds max length" as the z.ai CN overflow pattern, so
		// compaction works even without our rewrite — asserted here so a future pi
		// that drops it is a test failure, not a silent regression.
		assert.equal(isContextOverflow(errored(LIVE.overflow), 131_072), true);
		assert.equal(isContextOverflow(errored(normalizeOverflowError(LIVE.overflow)!), 131_072), true);
	});

	test("parameter-range rejections are not overflow", () => {
		// max_tokens rejections disclose the output cap; treating them as overflow
		// would compact the transcript for a client-side bug.
		assert.equal(normalizeOverflowError(LIVE.maxTokens1210), null);
		assert.equal(isContextOverflow(errored(LIVE.maxTokens1210), 131_072), false);
	});

	test("is idempotent", () => {
		assert.equal(normalizeOverflowError("context_length_exceeded: boom"), null);
	});

	test("rate limits never trigger compaction", () => {
		for (const msg of [
			"429 Too Many Requests",
			"rate limit exceeded, retry later",
			"429 当前请求频率过高",
		]) {
			assert.equal(normalizeOverflowError(msg), null, msg);
		}
	});

	test("unrelated errors pass through as null", () => {
		assert.equal(normalizeOverflowError("401 令牌已过期或验证不正确"), null);
		assert.equal(normalizeOverflowError("400 模型不存在，请检查模型代码。"), null);
		assert.equal(normalizeOverflowError(""), null);
	});
});

describe("shouldClarify / clarifyErrorMessage", () => {
	test("recognizes the live 401 wording", () => {
		assert.equal(shouldClarify({ errorMessage: LIVE.auth1000 }), true, "the 2026-10-09 body must match");
		assert.equal(shouldClarify({ errorMessage: "401 令牌已过期或验证不正确" }), true);
		assert.equal(shouldClarify({ errorMessage: "403 forbidden" }), true);
		assert.equal(shouldClarify({ errorMessage: "400 模型不存在" }), false);
		assert.equal(shouldClarify({}), false);
	});

	test("recognizes the documented 401 family without an HTTP status prefix", () => {
		// api-code.md: 1000 身份验证失败, 1001 未收到 Authentication, 1003 令牌已过期,
		// 1005 二次认证. A proxy that strips the status must not lose the hint.
		for (const msg of [
			'{"code":"1000","message":"身份验证失败。"}',
			'{"code":"1001","message":"Header 中未收到 Authentication 参数，无法进行身份验证"}',
			'{"code":"1003","message":"Authentication Token 已过期，请重新生成/获取"}',
		]) {
			assert.equal(shouldClarify({ errorMessage: msg }), true, msg);
			assert.ok(clarifyErrorMessage(msg), msg);
		}
	});

	test("rewrites into an actionable hint and keeps the original", () => {
		const out = clarifyErrorMessage(LIVE.auth1000);
		assert.ok(out, "expected a rewrite");
		assert.match(out!, /\/login bigmodel/);
		assert.match(out!, /BIGMODEL_API_KEY/);
		assert.match(out!, /open\.bigmodel\.cn/);
		assert.ok(out!.includes(LIVE.auth1000), "original must survive");
	});

	test("non-auth errors are left alone", () => {
		assert.equal(clarifyErrorMessage("500 internal"), undefined);
		assert.equal(clarifyErrorMessage(LIVE.modelMissing1211), undefined);
		assert.equal(clarifyErrorMessage(LIVE.balance1113), undefined, "balance is not an auth problem");
		assert.equal(clarifyErrorMessage(""), undefined);
	});
});

describe("permanent 429s (balance / quota / plan)", () => {
	test("classifies the documented non-transient codes", () => {
		assert.equal(classifyLimitError(LIVE.balance1113)?.kind, "balance");
		assert.equal(classifyLimitError(LIVE.balance1113)?.code, "1113");
		for (const code of ["1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"]) {
			assert.equal(classifyLimitError(`429: {"code":"${code}","message":"已达到使用上限"}`)?.kind, "quota", code);
		}
		for (const code of ["1309", "1311", "1314", "1315"]) {
			assert.equal(classifyLimitError(`429: {"code":"${code}","message":"套餐问题"}`)?.kind, "plan", code);
		}
	});

	test("leaves transient throttles alone so pi keeps retrying them", () => {
		for (const msg of [LIVE.modelOverload1305, '429: {"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}', '429: {"code":"1313","message":"公平使用策略"}']) {
			assert.equal(classifyLimitError(msg), undefined, msg);
			assert.equal(clarifyLimitErrorMessage(msg), undefined, msg);
			assert.equal(isRetryableAssistantError(errored(msg)), true, `pi must retry ${msg}`);
		}
	});

	test("wording fallback works when a proxy drops the numeric code", () => {
		assert.equal(classifyLimitError("429: 余额不足,请充值")?.kind, "balance");
		assert.equal(classifyLimitError("429: 您的 GLM Coding Plan 套餐已到期")?.kind, "plan");
	});

	test("the rewrite stops pi from retrying an empty balance", () => {
		// The mechanism: pi checks a NON_RETRYABLE deny-list before its retryable
		// patterns (pi-ai/dist/utils/retry.js), and that list contains "billing" and
		// "quota exceeded". The raw body carries "429", which IS retryable — measured
		// 2026-10-09 as ~16 s of pointless retries in print mode.
		assert.equal(isRetryableAssistantError(errored(LIVE.balance1113)), true, "precondition: the raw body is retryable");
		const rewritten = clarifyLimitErrorMessage(LIVE.balance1113)!;
		assert.equal(isRetryableAssistantError(errored(rewritten)), false, "the rewrite must be non-retryable");
		assert.equal(isContextOverflow(errored(rewritten), 131_072), false, "and must not trigger compaction");
		assert.ok(rewritten.includes(LIVE.balance1113), "original must survive");
		assert.match(rewritten, /bigmodel\.cn\/finance/);
		assert.match(rewritten, /glm-4\.7-flash/, "should point at the models that still work");
	});

	test("quota and plan rewrites are also non-retryable", () => {
		for (const msg of ['429: {"code":"1310","message":"您已达到每周/每月使用上限"}', '429: {"code":"1315","message":"该 API Key 仅限企业编程套餐场景使用"}']) {
			const rewritten = clarifyLimitErrorMessage(msg)!;
			assert.equal(isRetryableAssistantError(errored(rewritten)), false, msg);
			assert.equal(isContextOverflow(errored(rewritten), 131_072), false, msg);
			assert.ok(rewritten.includes(msg));
		}
		assert.match(clarifyLimitErrorMessage('429: {"code":"1315","message":"x"}')!, /zai-coding-cn/, "plan errors should name the right provider");
	});

	test("rewrites are idempotent", () => {
		// pi emits message_end once per message, but a rewrite that fed itself back
		// must not stack: both classifiers refuse text they already produced.
		const limit = clarifyLimitErrorMessage(LIVE.balance1113)!;
		assert.equal(clarifyLimitErrorMessage(limit), undefined);
		assert.equal(classifyLimitError(limit), undefined);
		const auth = clarifyErrorMessage(LIVE.auth1000)!;
		assert.equal(clarifyErrorMessage(auth), undefined);
		const overflow = normalizeOverflowError(LIVE.overflow)!;
		assert.equal(normalizeOverflowError(overflow), null);
	});

	test("non-429 gateway errors are not limit errors", () => {
		for (const msg of [LIVE.overflow, LIVE.auth1000, LIVE.forcedThinking1210, LIVE.modelMissing1211]) {
			assert.equal(clarifyLimitErrorMessage(msg), undefined, msg);
		}
	});
});
