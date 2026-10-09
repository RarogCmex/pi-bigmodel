/**
 * bigmodel_search sidecar tests — all offline, fetch stubbed per test.
 *
 * Fixtures under test/fixtures/ are REAL gateway bodies captured 2026-10-09
 * (research/evidence-2026-10-09-platform.json, stages `paid`,
 * `search-tool-validation`, `followup-paid-2/3`): a search_std 200, a
 * search_pro 200, a chat+web_search 200, and the 1113/1211/1305 error
 * envelopes. The chat fixture keeps one web_search entry because the captured
 * text was truncated mid-array; the parser contract is unaffected.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
	BIGMODEL_NAMESPACE,
	BIGMODEL_SEARCH_ANNOTATIONS,
	buildAskRequest,
	buildSearchTool,
	buildWebSearchRequest,
	fallbackAgentDir,
	formatAskText,
	formatSearchText,
	isSearchEngine,
	isSearchExposure,
	loadSearchConfig,
	parseAskResponse,
	parseWebSearchResponse,
	readStoredApiKey,
	resolveAskModel,
	resolveSearchEngine,
	resolveSearchExposure,
	saveSearchConfig,
	searchErrorMessage,
	searchStatus,
	type SearchToolParams,
} from "../search.ts";

const fixtures = {
	searchStd: JSON.parse(readFileSync(new URL("./fixtures/web-search-std.json", import.meta.url), "utf8")),
	searchPro: JSON.parse(readFileSync(new URL("./fixtures/web-search-pro.json", import.meta.url), "utf8")),
	chatSearch: JSON.parse(readFileSync(new URL("./fixtures/chat-websearch.json", import.meta.url), "utf8")),
	errors: JSON.parse(readFileSync(new URL("./fixtures/web-search-errors.json", import.meta.url), "utf8")),
};

// ── Config & resolution ─────────────────────────────────────────────────────

describe("search config", () => {
	it("exposure defaults to codemode and only opt-in values survive", () => {
		assert.equal(resolveSearchExposure({}), "codemode");
		assert.equal(resolveSearchExposure({ searchExposure: "off" }), "off");
		assert.equal(resolveSearchExposure({ searchExposure: "direct" }), "direct");
		assert.equal(resolveSearchExposure({ searchExposure: "nonsense" as never }), "codemode");
		assert.equal(resolveSearchExposure({ searchExposure: undefined }), "codemode");
	});

	it("engine defaults to search_std; unknown ids fall back", () => {
		assert.equal(resolveSearchEngine({}), "search_std");
		assert.equal(resolveSearchEngine({ searchEngine: "search_pro_quark" }), "search_pro_quark");
		assert.equal(resolveSearchEngine({ searchEngine: "search_ultra" as never }), "search_std");
		assert.ok(isSearchEngine("search_pro"));
		assert.ok(!isSearchEngine("gpt-4"));
		assert.ok(isSearchExposure("deferred"));
		assert.ok(!isSearchExposure("always"));
	});

	it("ask model defaults to the free glm-4-flash-250414; blank falls back", () => {
		assert.equal(resolveAskModel({}), "glm-4-flash-250414");
		assert.equal(resolveAskModel({ askModel: "  " }), "glm-4-flash-250414");
		assert.equal(resolveAskModel({ askModel: "glm-5.3-flash" }), "glm-5.3-flash");
	});

	it("config roundtrips through disk; corrupt or missing files read as defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bm-cfg-"));
		try {
			assert.deepEqual(loadSearchConfig(dir), {});
			saveSearchConfig(dir, { searchExposure: "direct", searchEngine: "search_pro" });
			assert.deepEqual(loadSearchConfig(dir), { searchExposure: "direct", searchEngine: "search_pro" });
			writeFileSync(join(dir, "pi-bigmodel.json"), "{ not json", "utf8");
			assert.deepEqual(loadSearchConfig(dir), {});
			const s = searchStatus({});
			assert.deepEqual(s, { exposure: "codemode", engine: "search_std", askModel: "glm-4-flash-250414" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("agent dir: PI_CODING_AGENT_DIR wins, then ~/.pi/agent", () => {
		assert.equal(fallbackAgentDir(() => "/custom/dir"), "/custom/dir");
		assert.match(fallbackAgentDir(() => undefined), /\.pi[\\/]agent$/);
	});
});

// ── Key resolution ──────────────────────────────────────────────────────────

describe("key resolution", () => {
	it("reads and trims the /login key from pi's auth.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bm-auth-"));
		try {
			assert.equal(readStoredApiKey(dir), undefined);
			writeFileSync(join(dir, "auth.json"), JSON.stringify({ bigmodel: { type: "api_key", key: "  abc.def  " } }), "utf8");
			assert.equal(readStoredApiKey(dir), "abc.def");
			writeFileSync(join(dir, "auth.json"), "{ broken", "utf8");
			assert.equal(readStoredApiKey(dir), undefined);
			writeFileSync(join(dir, "auth.json"), JSON.stringify({ other: { key: "x" } }), "utf8");
			assert.equal(readStoredApiKey(dir), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── Request building ────────────────────────────────────────────────────────

describe("request building", () => {
	it("search: documented defaults, clamped count, intent on, trimmed domain", () => {
		const req = buildWebSearchRequest("智谱AI GLM", "search_std");
		assert.equal(req.search_query, "智谱AI GLM");
		assert.equal(req.search_engine, "search_std");
		assert.equal(req.search_intent, true);
		assert.equal(req.count, 5);
		assert.equal(req.search_recency_filter, "noLimit");
		assert.equal(req.content_size, "medium");
		assert.ok(req.request_id.startsWith("pi-bmsearch-"));
		assert.ok(!("search_domain_filter" in req));

		const clamped = buildWebSearchRequest("q", "search_pro", { count: 500, recency: "oneWeek", domain: "  www.sohu.com  ", contentSize: "high" });
		assert.equal(clamped.count, 50);
		assert.equal(clamped.search_recency_filter, "oneWeek");
		assert.equal(clamped.search_domain_filter, "www.sohu.com");
		assert.equal(clamped.content_size, "high");
		assert.equal(buildWebSearchRequest("q", "search_std", { count: 0 }).count, 1);
	});

	it("ask: free model by default, builtin web_search tool, bounded tokens", () => {
		const req = buildAskRequest("вопрос", "glm-4-flash-250414", "search_pro_sogou");
		assert.equal(req.model, "glm-4-flash-250414");
		assert.equal(req.max_tokens, 1024);
		assert.deepEqual(req.messages, [{ role: "user", content: "вопрос" }]);
		assert.equal(req.tools[0].type, "web_search");
		assert.equal(req.tools[0].web_search.search_engine, "search_pro_sogou");
		assert.equal(req.tools[0].web_search.enable, true);
		assert.equal(req.tools[0].web_search.search_result, true);
		assert.equal(req.tools[0].web_search.count, 5);
		assert.equal(buildAskRequest("q", "m", "search_std", { maxTokens: 99_999 }).max_tokens, 8192);
	});
});

// ── Response parsing (fixtures are live bodies) ─────────────────────────────

describe("response parsing", () => {
	it("search_std fixture: intent + two hits (measured: this engine returned empty link/media)", () => {
		const parsed = parseWebSearchResponse(fixtures.searchStd);
		assert.equal(parsed.intent, "SEARCH_ALL");
		assert.equal(parsed.keywords, "智谱ai glm 最新模型");
		assert.equal(parsed.hits.length, 2);
		const first = parsed.hits[0];
		assert.equal(first.title, "德国“主权 AI”自曝：GLM、Qwen 成主要数据生成模型");
		assert.equal(first.url, "");
		assert.equal(first.media, undefined);
		assert.equal(first.published, "2026-10-04");
		assert.ok(first.snippet.length > 50);
	});

	it("search_pro fixture: same shape, its own hits", () => {
		const parsed = parseWebSearchResponse(fixtures.searchPro);
		assert.equal(parsed.hits.length, 2);
		assert.ok(parsed.hits[0].title.includes("GLM-5.3"));
		assert.equal(parsed.hits[0].published, "2026-09-30");
	});

	it("empty/garbage bodies parse to empty results, not throws; a missing web_search array marks ask as unsearched", () => {
		assert.deepEqual(parseWebSearchResponse(null), { intent: undefined, keywords: undefined, hits: [] });
		assert.deepEqual(parseWebSearchResponse({}), { intent: undefined, keywords: undefined, hits: [] });
		assert.deepEqual(parseAskResponse({}), { answer: "", searched: false, hits: [] });
		assert.equal(parseAskResponse(fixtures.chatSearch).searched, true);
		// a present-but-empty array is a REAL search with no hits — not a skip
		assert.equal(parseAskResponse({ choices: [{ message: { content: "x" } }], web_search: [] }).searched, true);
	});

	it("chat+web_search fixture: answer + echoed sources (link was empty in the live capture)", () => {
		const parsed = parseAskResponse(fixtures.chatSearch);
		assert.equal(parsed.answer, "智谱AI最新发布的模型是GLM-6.0。");
		assert.equal(parsed.hits.length, 1);
		assert.ok(parsed.hits[0].title.includes("GLM-6.0"));
		assert.equal(parsed.hits[0].url, "");
		assert.equal(parsed.hits[0].published, "2026-09-14");
	});
});

// ── Formatting ──────────────────────────────────────────────────────────────

describe("formatting", () => {
	it("search text carries intent, numbered hits and the cost line (url lines skipped when empty)", () => {
		const parsed = parseWebSearchResponse(fixtures.searchStd);
		const text = formatSearchText(parsed, "search_std");
		assert.ok(text.includes("intent: SEARCH_ALL"));
		assert.ok(text.includes("[1] 德国“主权 AI”自曝"));
		assert.ok(text.includes("2026-10-04"));
		assert.ok(!text.includes("    https://"), "empty links must not render url lines");
		assert.ok(text.includes("движок: search_std"));
		assert.ok(text.includes("¥0.01"));
	});

	it("search text renders url lines when a hit has one", () => {
		const parsed = parseWebSearchResponse({ search_result: [{ title: "t", link: "https://x.example/a", content: "c" }] });
		assert.ok(formatSearchText(parsed, "search_std").includes("https://x.example/a"));
	});

	it("ask text carries the answer, a sources list and the free-model note", () => {
		const parsed = parseAskResponse(fixtures.chatSearch);
		const text = formatAskText(parsed, "glm-4-flash-250414", "search_std");
		assert.ok(text.includes("智谱AI最新发布的模型是GLM-6.0。"));
		assert.ok(text.includes("источники:"));
		assert.ok(text.includes("модель: glm-4-flash-250414 (бесплатная)"));
	});
});

// ── Error mapping (fixtures are live bodies) ────────────────────────────────

describe("error mapping", () => {
	it("429/1113 → billing message with the per-call prices", () => {
		const msg = searchErrorMessage(429, fixtures.errors.balance);
		assert.ok(msg.includes("нет средств"));
		assert.ok(msg.includes("¥0.01"));
		assert.ok(msg.includes("open.bigmodel.cn"));
		assert.ok(msg.includes("отказ не тарифицируется"));
	});

	it("400/1211 → engine vocabulary (engines are models to this endpoint)", () => {
		const msg = searchErrorMessage(400, fixtures.errors.engine);
		assert.ok(msg.includes("неизвестный поисковый движок"));
		assert.ok(msg.includes("search_std, search_pro, search_pro_sogou, search_pro_quark"));
	});

	it("429/1305 → transient overload, retry later", () => {
		const msg = searchErrorMessage(429, fixtures.errors.throttle);
		assert.ok(msg.includes("перегружен"));
		assert.ok(msg.includes("Повторите"));
	});

	it("401 and auth codes → key guidance", () => {
		const msg = searchErrorMessage(401, { error: { code: "1000", message: "身份验证失败。" } });
		assert.ok(msg.includes("ключ недействителен"));
		assert.ok(msg.includes("/login bigmodel"));
		const viaCode = searchErrorMessage(200, { error: { code: "1003", message: "令牌已过期" } });
		assert.ok(viaCode.includes("ключ недействителен"));
	});

	it("anything else → status + code + message, no invention", () => {
		const msg = searchErrorMessage(500, { error: { code: "9999", message: "boom" } });
		assert.ok(msg.includes("HTTP 500"));
		assert.ok(msg.includes("9999"));
		assert.ok(msg.includes("boom"));
	});
});

// ── Tool definition ─────────────────────────────────────────────────────────

describe("tool definition", () => {
	it("metadata: codemode by default, off collapses, namespace and hints", () => {
		const tool = buildSearchTool({}, { agentDir: () => "/nonexistent" });
		assert.equal(tool.name, "bigmodel_search");
		assert.equal(tool.exposure, "codemode");
		assert.equal(tool.namespace, BIGMODEL_NAMESPACE);
		assert.equal(BIGMODEL_NAMESPACE.name, "bigmodel");
		assert.equal(BIGMODEL_SEARCH_ANNOTATIONS.readOnlyHint, true);
		assert.equal(BIGMODEL_SEARCH_ANNOTATIONS.openWorldHint, true);
		assert.equal(buildSearchTool({ searchExposure: "off" }, { agentDir: () => "/x" }).exposure, "off");
		assert.equal(buildSearchTool({ searchExposure: "direct" }, { agentDir: () => "/x" }).exposure, "direct");
	});
});

// ── execute() end to end with a stubbed fetch ───────────────────────────────

describe("execute", () => {
	const realEnv: Record<string, string | undefined> = {};
	let dir: string;
	let calls: Array<{ url: string; headers: Record<string, string>; body: any }>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-bm-exec-"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ bigmodel: { type: "api_key", key: "test.key" } }), "utf8");
		calls = [];
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function stubFetch(status: number, body: unknown) {
		return (async (url: any, init: any) => {
			calls.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? "{}") });
			return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		}) as unknown as typeof fetch;
	}

	it("search: right URL, right body, structured sources", async () => {
		const tool = buildSearchTool({}, { agentDir: () => dir, fetch: stubFetch(200, fixtures.searchStd), env: (n) => realEnv[n] });
		const result = await tool.execute("call-1", { action: "search", task: "智谱AI GLM 最新模型" } as SearchToolParams, undefined, undefined, {} as never);
		assert.equal(calls.length, 1);
		assert.ok(calls[0].url.endsWith("/api/paas/v4/web_search"));
		assert.equal(calls[0].headers.Authorization, "Bearer test.key");
		assert.equal(calls[0].body.search_engine, "search_std");
		assert.equal(calls[0].body.search_intent, true);
		assert.ok((result.content as Array<{ type: string; text: string }>)[0].text.includes("¥0.01"));
		const sc = result.structuredContent as { action: string; sources: unknown[]; engine: string; intent?: string };
		assert.equal(sc.action, "search");
		assert.equal(sc.engine, "search_std");
		assert.equal(sc.intent, "SEARCH_ALL");
		assert.equal(sc.sources.length, 2);
	});

	it("ask: free model + builtin tool, answer and sources parsed", async () => {
		const tool = buildSearchTool({}, { agentDir: () => dir, fetch: stubFetch(200, fixtures.chatSearch), env: (n) => realEnv[n] });
		const result = await tool.execute("call-2", { action: "ask", task: "智谱AI最新发布的模型是什么？" } as SearchToolParams, undefined, undefined, {} as never);
		assert.ok(calls[0].url.endsWith("/api/paas/v4/chat/completions"));
		assert.equal(calls[0].body.model, "glm-4-flash-250414");
		assert.equal(calls[0].body.tools[0].type, "web_search");
		const sc = result.structuredContent as { action: string; result: string; sources: unknown[]; costNote: string };
		assert.equal(sc.action, "ask");
		assert.equal(sc.result, "智谱AI最新发布的模型是GLM-6.0。");
		assert.equal(sc.sources.length, 1);
		assert.ok(sc.costNote.includes("free"));
	});

	it("ask with a silently-skipped search (measured on a zero-balance key) throws, never returns an ungrounded answer", async () => {
		// The real zero-balance body: 200, an answer from parametric knowledge,
		// no web_search array, no error (captured live 2026-10-09 on KEY1).
		const ungrounded = {
			choices: [{ finish_reason: "stop", message: { content: "智谱AI最新发布的模型是GLM-4。", role: "assistant" } }],
			model: "glm-4-flash-250414",
			usage: { completion_tokens: 12, prompt_tokens: 7, total_tokens: 19 },
		};
		const tool = buildSearchTool({}, { agentDir: () => dir, fetch: stubFetch(200, ungrounded), env: (n) => realEnv[n] });
		await assert.rejects(
			tool.execute("call-2b", { action: "ask", task: "智谱AI最新发布的模型是什么？" } as SearchToolParams, undefined, undefined, {} as never),
			/встроенный поиск не выполнился.*не подкрепл[её]н источниками/s,
		);
	});

	it("engine and count flow through; BIGMODEL_BASE_URL is honoured", async () => {
		const tool = buildSearchTool(
			{ searchEngine: "search_pro_quark" },
			{ agentDir: () => dir, fetch: stubFetch(200, fixtures.searchStd), env: (n) => (n === "BIGMODEL_BASE_URL" ? "https://proxy.example/v4" : undefined) },
		);
		await tool.execute("call-3", { action: "search", task: "q", count: 3 } as SearchToolParams, undefined, undefined, {} as never);
		assert.ok(calls[0].url.startsWith("https://proxy.example/v4/"));
		assert.equal(calls[0].body.search_engine, "search_pro_quark");
		assert.equal(calls[0].body.count, 3);
	});

	it("billing failure throws the rewritten message, not the raw body", async () => {
		const tool = buildSearchTool({}, { agentDir: () => dir, fetch: stubFetch(429, fixtures.errors.balance), env: (n) => realEnv[n] });
		await assert.rejects(
			tool.execute("call-4", { action: "search", task: "q" } as SearchToolParams, undefined, undefined, {} as never),
			/нет средств.*¥0\.01/s,
		);
	});

	it("no key anywhere → actionable Russian error", async () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "pi-bm-nok-"));
		try {
			const tool = buildSearchTool({}, { agentDir: () => emptyDir, fetch: stubFetch(200, {}), env: () => undefined });
			await assert.rejects(
				tool.execute("call-5", { task: "q" } as SearchToolParams, undefined, undefined, {} as never),
				/\/login bigmodel/,
			);
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});

	it("env key is used when the auth store is empty", async () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "pi-bm-envk-"));
		try {
			const tool = buildSearchTool({}, { agentDir: () => emptyDir, fetch: stubFetch(200, fixtures.searchStd), env: (n) => (n === "BIGMODEL_API_KEY" ? "env.key" : undefined) });
			await tool.execute("call-6", { task: "q" } as SearchToolParams, undefined, undefined, {} as never);
			assert.equal(calls[0].headers.Authorization, "Bearer env.key");
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});
});

// (SearchEngine/SearchConfig appear only via inference; the import list stays minimal.)
