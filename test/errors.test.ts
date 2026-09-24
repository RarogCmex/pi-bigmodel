import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { clarifyErrorMessage, normalizeOverflowError, shouldClarify } from "../errors.ts";

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
		assert.equal(shouldClarify({ errorMessage: "401 令牌已过期或验证不正确" }), true);
		assert.equal(shouldClarify({ errorMessage: "403 forbidden" }), true);
		assert.equal(shouldClarify({ errorMessage: "400 模型不存在" }), false);
		assert.equal(shouldClarify({}), false);
	});

	test("rewrites into an actionable hint and keeps the original", () => {
		const out = clarifyErrorMessage("401 令牌已过期或验证不正确");
		assert.ok(out, "expected a rewrite");
		assert.match(out!, /\/login bigmodel/);
		assert.match(out!, /BIGMODEL_API_KEY/);
		assert.match(out!, /open\.bigmodel\.cn/);
		assert.ok(out!.includes("401 令牌已过期或验证不正确"), "original must survive");
	});

	test("non-auth errors are left alone", () => {
		assert.equal(clarifyErrorMessage("500 internal"), undefined);
		assert.equal(clarifyErrorMessage(""), undefined);
	});
});
