import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	clarifyErrorMessage,
	clarifyLimitErrorMessage,
	classifyLimitError,
	classifyRewritten,
	normalizeOverflowError,
	parseInBandError,
	remediateInBandResponse,
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

	test("the two-character 超长 matcher needs a length-ish context", () => {
		// 超长 alone is short enough to false-positive on unrelated Chinese text, and
		// a false positive here triggers auto-compaction — the most destructive
		// mistake this layer can make. So the matcher requires a prompt/length word
		// within 12 characters on one side, and these negatives are the proof.
		assert.equal(normalizeOverflowError('400: {"code":"1261","message":"Prompt 超长"}'), 'context_length_exceeded: 400: {"code":"1261","message":"Prompt 超长"}');
		assert.equal(normalizeOverflowError("输入超长，请缩短后重试"), "context_length_exceeded: 输入超长，请缩短后重试");
		assert.equal(normalizeOverflowError("上下文超长"), "context_length_exceeded: 上下文超长");
		for (const msg of [
			'400: {"code":"1210","message":"max_tokens参数非法：限制数值范围[1,98304]"}',
			'400: {"code":"1210","message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}',
			'400: {"code":"1301","message":"系统检测到输入或生成内容可能包含不安全或敏感内容"}',
			"400: 模型不存在，请检查模型代码。",
			"500: 内部错误",
			"工具输出超长已被截断", // a truncation notice is not a prompt overflow
		]) {
			assert.equal(normalizeOverflowError(msg), null, msg);
		}
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

describe("the Responses surface reports limits with OpenAI-style codes", () => {
	test("insufficient_quota is a balance problem, and pi already refuses to retry it", () => {
		// Live body, 2026-10-09: 429 {"error":{"code":"insufficient_quota",
		// "message":"余额不足或无可用资源包,请充值。"}}
		const msg = '429: {"code":"insufficient_quota","message":"余额不足或无可用资源包,请充值。"}';
		assert.equal(classifyLimitError(msg)?.kind, "balance");
		const rewritten = clarifyLimitErrorMessage(msg)!;
		assert.equal(isRetryableAssistantError(errored(rewritten)), false);
		// pi's own deny-list already contains insufficient_quota, so even the raw
		// body would not be retried here — the rewrite is for the human, not for
		// the retry logic.
		assert.equal(isRetryableAssistantError(errored(msg)), false);
	});

	test("overloaded stays transient", () => {
		const msg = '429: {"code":"overloaded","message":"该模型当前访问量过大，请您稍后再试"}';
		assert.equal(classifyLimitError(msg), undefined);
		assert.equal(isRetryableAssistantError(errored(msg)), true);
	});

	test("context_length_exceeded from this surface still means compaction", () => {
		// Live body, 2026-10-09: 400 {"code":"context_length_exceeded",
		// "message":"Prompt exceeds max length"} — the code alone is enough for pi.
		const msg = '400: {"code":"context_length_exceeded","message":"Prompt exceeds max length"}';
		assert.equal(isContextOverflow(errored(msg), 131_072), true);
		assert.equal(normalizeOverflowError(msg), null, "already carries the marker: must stay idempotent");
		assert.equal(classifyLimitError(msg), undefined, "and must not be mistaken for a limit error");
	});
});

describe("in-band HTTP-200 errors on the Responses surface", () => {
	// Recorded live 2026-10-09. The Responses endpoint answers a bad or missing
	// credential with HTTP 200 and this body, which pi (streaming) would otherwise
	// report as "stream ended before a terminal response event" — retryable, and
	// silent about the actual problem.
	const REVOKED = '{"code":1000,"msg":"身份验证失败。","success":false}';
	const NO_HEADER = '{"code":1001,"msg":"Header中未收到Authorization参数，无法进行身份验证。","success":false}';

	function json200(body: string): Response {
		return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
	}
	function sse200(body: string): Response {
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	test("parseInBandError only accepts the documented shape", () => {
		assert.deepEqual(parseInBandError(REVOKED), { code: 1000, msg: "身份验证失败。" });
		assert.equal(parseInBandError('{"object":"response","status":"completed"}'), undefined);
		assert.equal(parseInBandError('{"code":1000,"msg":"x"}'), undefined, "success:false is required");
		assert.equal(parseInBandError('{"code":"1000","msg":"x","success":false}'), undefined, "code must be numeric");
		assert.equal(parseInBandError("event: response.created\n"), undefined);
		assert.equal(parseInBandError(""), undefined);
		assert.equal(parseInBandError("{truncated"), undefined);
	});

	test("a 200 in-band auth error becomes a real 401 with the standard envelope", async () => {
		const remediated = await remediateInBandResponse(json200(REVOKED));
		assert.equal(remediated.status, 401);
		assert.deepEqual(JSON.parse(await remediated.text()), { error: { code: "1000", message: "身份验证失败。" } });
	});

	test("the documented status is restored per code", async () => {
		assert.equal((await remediateInBandResponse(json200(NO_HEADER))).status, 401);
		assert.equal(
			(await remediateInBandResponse(json200('{"code":1113,"msg":"您的账户已欠费，请充值后重试","success":false}'))).status,
			429,
		);
		assert.equal(
			(await remediateInBandResponse(json200('{"code":1261,"msg":"Prompt 超长","success":false}'))).status,
			400,
		);
		assert.equal(
			(await remediateInBandResponse(json200('{"code":1220,"msg":"您无权访问","success":false}'))).status,
			403,
		);
	});

	test("the remediated body flows into the existing auth rewrite", async () => {
		const remediated = await remediateInBandResponse(json200(REVOKED));
		const surfaced = `${remediated.status}: ${JSON.stringify((await remediated.json()).error)}`;
		assert.equal(shouldClarify({ errorMessage: surfaced }), true);
		const clarified = clarifyErrorMessage(surfaced)!;
		assert.match(clarified, /\/login bigmodel/);
		assert.ok(clarified.includes("身份验证失败"), "the gateway's own wording survives");
	});

	test("everything that is not an in-band error passes through untouched", async () => {
		// A successful stream must keep its body: the wrapper reads via clone().
		const stream = sse200("event: response.created\ndata: {}\n\n");
		assert.equal(await remediateInBandResponse(stream), stream);
		assert.match(await stream.text(), /response\.created/);

		const ok = json200('{"object":"response","status":"completed","output":[]}');
		assert.equal(await remediateInBandResponse(ok), ok);

		const alreadyError = new Response('{"error":{"code":"1000","message":"x"}}', {
			status: 401,
			headers: { "content-type": "application/json" },
		});
		assert.equal(await remediateInBandResponse(alreadyError), alreadyError, "non-200 is left alone");

		const html = new Response("<html>502 Bad Gateway</html>", {
			status: 200,
			headers: { "content-type": "text/html" },
		});
		assert.equal(await remediateInBandResponse(html), html, "a proxy page is not ours to reinterpret");
	});
});

describe("classifyRewritten — reading our own tags back after pi's in-place rewrite", () => {
	// pi replaces the assistant message IN PLACE before turn_end
	// (agent-session.js `_replaceMessageInPlace`), so a handler that classified the
	// gateway body again would see the rewrite and find nothing. These assert the
	// order-independent path; test/entry.test.ts runs the real hook sequence.
	test("the limit tag carries the kind, and the deny-list phrase survives", () => {
		const balance = clarifyLimitErrorMessage(LIVE.balance1113)!;
		assert.match(balance, /\[billing 1113 balance\]/);
		assert.deepEqual(classifyRewritten(balance), { type: "limit", kind: "balance" });
		assert.equal(isRetryableAssistantError(errored(balance)), false);

		const quota = clarifyLimitErrorMessage('429: {"code":"1310","message":"您已达到每周/每月使用上限"}')!;
		assert.match(quota, /\[quota exceeded 1310 quota\]/);
		assert.deepEqual(classifyRewritten(quota), { type: "limit", kind: "quota" });
		assert.equal(isRetryableAssistantError(errored(quota)), false);

		const plan = clarifyLimitErrorMessage('429: {"code":"1315","message":"该 API Key 仅限企业编程套餐场景使用"}')!;
		assert.deepEqual(classifyRewritten(plan), { type: "limit", kind: "plan" });
	});

	test("the auth rewrite is recognisable without quoting the original body", () => {
		const auth = clarifyErrorMessage(LIVE.auth1000)!;
		assert.deepEqual(classifyRewritten(auth), { type: "auth" });
	});

	test("gateway text that is not ours is never claimed", () => {
		for (const msg of [LIVE.balance1113, LIVE.auth1000, LIVE.modelOverload1305, LIVE.overflow, ""]) {
			assert.equal(classifyRewritten(msg), undefined, msg);
		}
		// A user-visible string that merely mentions the words must not be mistaken
		// for our tag: the bracket shape and the kind token are both required.
		assert.equal(classifyRewritten("billing 1113 balance"), undefined);
		assert.equal(classifyRewritten("[billing] something"), undefined);
	});
});
