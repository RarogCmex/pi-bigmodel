/**
 * Billed search sidecar: the `bigmodel_search` pi tool.
 *
 * Wraps the two platform surfaces the provider itself never touches
 * (research/2026-10-09-platform-services.md):
 *   - action=search — `POST {completions base}/web_search`: structured results
 *     (title/link/content/media/publish_date/refer) from Zhipu's own engine or
 *     Sogou/Quark. Billed **per call**: ¥0.01 std / ¥0.03 pro / ¥0.05 sogou|quark
 *     (measured: a zero-balance key gets 429/1113 before any param validation,
 *     so the tool's balance errors reuse the plugin's billing vocabulary);
 *   - action=ask — `POST {completions base}/chat/completions` on a **free**
 *     model with the gateway's builtin `web_search` tool: a search-grounded
 *     answer plus the sources the gateway echoes in a top-level `web_search[]`
 *     array. Costs the same one search fee; the model itself bills ¥0
 *     (glm-4-flash-250414, measured live 2026-10-09: 1863 injected input
 *     tokens, finish stop, sources attached).
 *
 * Exposure follows the pi-alibaba-models precedent: the tool is registered
 * with `exposure: "codemode"` by default — callable from codemode scripts,
 * never declared to the model on every turn — and the user moves it to
 * `direct`/`deferred` or disables it entirely via `/bigmodel`.
 *
 * This module must stay importable under plain Node (the offline test suite
 * imports it with fetch stubbed), so every pi import is `import type` and the
 * agent dir is injected: `index.ts` resolves it with pi's real `getAgentDir()`
 * at runtime, with a replicated `~/.pi/agent` fallback (config.js:491 on
 * pi 1.1.0) for installs where the package does not resolve.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { API_KEYS_URL } from "./errors.ts";
import { resolveBaseUrl } from "./models.ts";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Exposure vocabulary (mirrors the alibaba plugin, one shared label set) ──

export type SearchExposure = "codemode" | "direct" | "deferred" | "off";
export const SEARCH_EXPOSURES: readonly SearchExposure[] = ["codemode", "direct", "deferred", "off"];
export const SEARCH_EXPOSURE_LABELS: Record<SearchExposure, string> = {
	codemode: "codemode — callable from scripts, not declared every turn (default)",
	direct: "direct — declared to the model on every turn",
	deferred: "deferred — reachable through tool search",
	off: "off — not registered, costs nothing",
};

// ── Search engines and their per-call prices (docs + measured 2026-10-09) ──

export type SearchEngine = "search_std" | "search_pro" | "search_pro_sogou" | "search_pro_quark";
export const SEARCH_ENGINES: readonly SearchEngine[] = ["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"];
/** ¥ per call — the only thing this sidecar ever bills on the std/pro path. */
export const SEARCH_ENGINE_PRICES: Record<SearchEngine, number> = {
	search_std: 0.01,
	search_pro: 0.03,
	search_pro_sogou: 0.05,
	search_pro_quark: 0.05,
};
/** The free model `action:"ask"` runs on; the search fee is the whole cost. */
export const DEFAULT_ASK_MODEL = "glm-4-flash-250414";

export type Recency = "noLimit" | "oneDay" | "oneWeek" | "oneMonth" | "oneYear";
export const RECENCIES: readonly Recency[] = ["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"];

// ── Config (`{agentDir}/pi-bigmodel.json`, created on first write) ──────────

export interface SearchConfig {
	searchExposure?: SearchExposure;
	searchEngine?: SearchEngine;
	askModel?: string;
}

export function isSearchExposure(v: unknown): v is SearchExposure {
	return typeof v === "string" && (SEARCH_EXPOSURES as string[]).includes(v);
}
export function isSearchEngine(v: unknown): v is SearchEngine {
	return typeof v === "string" && (SEARCH_ENGINES as string[]).includes(v);
}

/** Unknown/missing values resolve to the defaults; `off` is opt-in only. */
export function resolveSearchExposure(cfg: SearchConfig): SearchExposure {
	return isSearchExposure(cfg.searchExposure) ? cfg.searchExposure : "codemode";
}
export function resolveSearchEngine(cfg: SearchConfig): SearchEngine {
	return isSearchEngine(cfg.searchEngine) ? cfg.searchEngine : "search_std";
}
export function resolveAskModel(cfg: SearchConfig): string {
	const id = typeof cfg.askModel === "string" ? cfg.askModel.trim() : "";
	return id || DEFAULT_ASK_MODEL;
}

export function searchConfigPath(agentDir: string): string {
	return join(agentDir, "pi-bigmodel.json");
}

export function loadSearchConfig(agentDir: string): SearchConfig {
	try {
		const raw = readFileSync(searchConfigPath(agentDir), "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as SearchConfig) : {};
	} catch {
		return {}; // missing or corrupt: defaults, never a boot failure
	}
}

/** Atomic-enough write: temp file + rename, so a crash cannot truncate the config. */
export function saveSearchConfig(agentDir: string, cfg: SearchConfig): void {
	const path = searchConfigPath(agentDir);
	mkdirSync(agentDir, { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(cfg, null, "\t") + "\n", "utf8");
	renameSync(tmp, path);
}

// ── Key resolution: pi's auth store, then the env var ──────────────────────
//
// `/login bigmodel` stores `{type:"api_key", key}` under the provider id in
// `{agentDir}/auth.json` (pi's envApiKeyAuth). The sidecar shares that key —
// no separate credential, no second login.

export function readStoredApiKey(agentDir: string): string | undefined {
	try {
		const raw = readFileSync(join(agentDir, "auth.json"), "utf8");
		const parsed = JSON.parse(raw);
		const key = parsed?.[PROVIDER_ID_ENTRY]?.key;
		return typeof key === "string" && key.trim() ? key.trim() : undefined;
	} catch {
		return undefined;
	}
}
const PROVIDER_ID_ENTRY = "bigmodel";

type EnvReader = (name: string) => string | undefined;
const processEnv: EnvReader = (name) => (typeof process !== "undefined" ? process.env?.[name] : undefined);

/** Agent dir as pi computes it (config.js `getAgentDir`, 1.1.0): env override, then `~/.pi/agent`. */
export function fallbackAgentDir(env: EnvReader = processEnv): string {
	return env("PI_CODING_AGENT_DIR") || join(homedir(), ".pi", "agent");
}

// ── Wire requests ──────────────────────────────────────────────────────────

export interface SearchToolParams {
	action?: string;
	task?: string;
	engine?: string;
	count?: number;
	recency?: string;
	domain?: string;
	content_size?: string;
}

export interface WebSearchRequest {
	search_query: string;
	search_engine: SearchEngine;
	search_intent: boolean;
	count: number;
	search_recency_filter: Recency;
	content_size: "medium" | "high";
	search_domain_filter?: string;
	request_id: string;
}

/** `action:"search"` body. `search_intent:true` is what makes the API return its intent analysis. */
export function buildWebSearchRequest(
	task: string,
	engine: SearchEngine,
	opts: { count?: number; recency?: Recency; domain?: string; contentSize?: "medium" | "high" } = {},
): WebSearchRequest {
	const req: WebSearchRequest = {
		search_query: task,
		search_engine: engine,
		search_intent: true,
		count: clamp(Math.trunc(opts.count ?? 5), 1, 50),
		search_recency_filter: opts.recency ?? "noLimit",
		content_size: opts.contentSize ?? "medium",
		request_id: requestId(),
	};
	if (opts.domain && opts.domain.trim()) req.search_domain_filter = opts.domain.trim();
	return req;
}

/** `action:"ask"` body: a free model plus the gateway's builtin search tool. */
export function buildAskRequest(
	task: string,
	model: string,
	engine: SearchEngine,
	opts: { count?: number; maxTokens?: number } = {},
) {
	return {
		model,
		messages: [{ role: "user", content: task }],
		max_tokens: clamp(Math.trunc(opts.maxTokens ?? 1024), 1, 8192),
		tools: [
			{
				type: "web_search",
				web_search: { enable: true, search_engine: engine, search_result: true, count: clamp(Math.trunc(opts.count ?? 5), 1, 50) },
			},
		],
	};
}

function requestId(): string {
	return `pi-bmsearch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

// ── Response parsing (shapes measured live, see research evidence) ─────────

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
	media?: string;
	published?: string;
}
export interface ParsedSearch {
	intent?: string;
	keywords?: string;
	hits: SearchHit[];
}
export interface ParsedAsk {
	answer: string;
	hits: SearchHit[];
	/** False when the response carries no `web_search[]` array — the gateway
	 * silently skipped the builtin tool (measured on a zero-balance key:
	 * 200, an answer from parametric knowledge, no sources, no error). */
	searched: boolean;
}

export function parseWebSearchResponse(body: unknown): ParsedSearch {
	const b = body as { search_intent?: Array<{ intent?: string; keywords?: string }>; search_result?: Array<Record<string, unknown>> } | null;
	const intentRow = Array.isArray(b?.search_intent) ? b.search_intent[0] : undefined;
	return {
		intent: intentRow?.intent,
		keywords: intentRow?.keywords,
		hits: (Array.isArray(b?.search_result) ? b.search_result : []).map((r) => ({
			title: str(r.title),
			url: str(r.link),
			snippet: str(r.content),
			media: str(r.media) || undefined,
			published: str(r.publish_date) || undefined,
		})),
	};
}

export function parseAskResponse(body: unknown): ParsedAsk {
	const b = body as { choices?: Array<{ message?: { content?: unknown } }>; web_search?: unknown } | null;
	const answer = b?.choices?.[0]?.message?.content;
	return {
		answer: typeof answer === "string" ? answer : "",
		searched: Array.isArray(b?.web_search),
		hits: (Array.isArray(b?.web_search) ? (b.web_search as Array<Record<string, unknown>>) : []).map((r) => ({
			title: str(r.title),
			url: str(r.link),
			snippet: str(r.content),
			media: str(r.media) || undefined,
			published: str(r.publish_date) || undefined,
		})),
	};
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

// ── Error mapping (Russian, the plugin's user-facing voice) ────────────────
//
// The gateway's own order (measured): billing first (429/1113 on an empty
// balance arrives even for an invalid engine), then engine validation
// (400/1211 «模型不存在» — engines are "models" to this endpoint).

export function searchErrorMessage(status: number, body: unknown): string {
	const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
	const code = String(err?.code ?? "");
	const message = String(err?.message ?? "");
	if (status === 429 && (code === "1113" || message.includes("余额不足"))) {
		return (
			"BigModel: на счете нет средств. Поиск тарифицируется за вызов — ¥0.01 (search_std), " +
			"¥0.03 (search_pro), ¥0.05 (search_pro_sogou/search_pro_quark); отказ не тарифицируется. " +
			`Пополните баланс: ${API_KEYS_URL}`
		);
	}
	if (status === 400 && code === "1211") {
		return `BigModel: неизвестный поисковый движок (${message}). Допустимые: ${SEARCH_ENGINES.join(", ")}.`;
	}
	if (status === 401 || ["1000", "1001", "1003", "1005"].includes(code)) {
		return `BigModel: ключ недействителен, отозван или истёк (${message}). Проверьте ключ: ${API_KEYS_URL} — затем \`/login bigmodel\` или BIGMODEL_API_KEY.`;
	}
	if (status === 429 && ["1302", "1305", "1313"].includes(code)) {
		return `BigModel: сервис перегружен или сработал rate limit (${message}). Повторите вызов позже.`;
	}
	return `BigModel web search: HTTP ${status}${code ? ` code ${code}` : ""}${message ? ` — ${message}` : ""}.`;
}

// ── Output formatting ──────────────────────────────────────────────────────

const SNIPPET_CHARS = 480;
const TOTAL_CHARS = 20_000;

export function formatSearchText(parsed: ParsedSearch, engine: SearchEngine): string {
	const lines: string[] = [];
	if (parsed.intent || parsed.keywords) {
		lines.push(`intent: ${parsed.intent ?? "?"}${parsed.keywords ? ` («${parsed.keywords}»)` : ""}`);
	}
	parsed.hits.forEach((h, i) => {
		lines.push(`[${i + 1}] ${h.title || "(без заголовка)"}${h.media ? ` — ${h.media}` : ""}${h.published ? `, ${h.published}` : ""}`);
		if (h.url) lines.push(`    ${h.url}`);
		const snippet = truncate(h.snippet, SNIPPET_CHARS);
		if (snippet) lines.push(`    ${snippet.replace(/\s+/g, " ").trim()}`);
	});
	if (!parsed.hits.length) lines.push("(результатов нет)");
	lines.push("", `движок: ${engine} · результатов: ${parsed.hits.length} · стоимость вызова: ¥${SEARCH_ENGINE_PRICES[engine].toFixed(2)}`);
	return truncate(lines.join("\n"), TOTAL_CHARS);
}

export function formatAskText(parsed: ParsedAsk, model: string, engine: SearchEngine): string {
	const lines: string[] = [parsed.answer.trim() || "(пустой ответ)"];
	if (parsed.hits.length) {
		lines.push("", "источники:");
		parsed.hits.forEach((h, i) => {
			lines.push(`[${i + 1}] ${h.title || h.url || "(без заголовка)"}${h.url ? `\n    ${h.url}` : ""}`);
		});
	}
	lines.push("", `модель: ${model} (бесплатная) · движок: ${engine} · стоимость: ¥${SEARCH_ENGINE_PRICES[engine].toFixed(2)} за поисковый вызов`);
	return truncate(lines.join("\n"), TOTAL_CHARS);
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── Tool surface ───────────────────────────────────────────────────────────

export const BIGMODEL_SEARCH_PARAMETERS = {
	type: "object" as const,
	properties: {
		action: {
			type: "string" as const,
			enum: ["search", "ask"],
			default: "search",
			description:
				"search: structured web results (title/url/snippet, default). ask: a search-grounded " +
				"answer with sources, synthesized by a free model. Both bill one search fee.",
		},
		task: {
			type: "string" as const,
			description: "Search query, or the question to answer. Keep queries under ~70 characters for best recall.",
		},
		engine: {
			type: "string" as const,
			enum: [...SEARCH_ENGINES],
			default: "search_std",
			description: "search_std ¥0.01/call (default); search_pro ¥0.03 (higher recall); search_pro_sogou / search_pro_quark ¥0.05 (Sogou/Quark indexes — strongest for Chinese web).",
		},
		count: {
			type: "number" as const,
			description: "Number of results (1-50, default 5).",
		},
		recency: {
			type: "string" as const,
			enum: [...RECENCIES],
			default: "noLimit",
			description: "Publication-time filter; default noLimit.",
		},
		domain: {
			type: "string" as const,
			description: "Restrict results to one domain (e.g. www.example.com). search action only.",
		},
		content_size: {
			type: "string" as const,
			enum: ["medium", "high"],
			default: "medium",
			description: "Snippet length: medium (default) or high (max context). search action only.",
		},
	},
	required: ["task"],
} as const;

export const BIGMODEL_SEARCH_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

export const BIGMODEL_SEARCH_OUTPUT_SCHEMA = {
	type: "object" as const,
	properties: {
		action: { type: "string" as const },
		result: { type: "string" as const },
		sources: {
			type: "array" as const,
			items: {
				type: "object" as const,
				properties: {
					title: { type: "string" as const },
					url: { type: "string" as const },
					snippet: { type: "string" as const },
				},
			},
		},
		intent: { type: "string" as const },
		engine: { type: "string" as const },
		costNote: { type: "string" as const },
	},
	required: ["action", "result", "sources", "engine"],
} as const;

export const BIGMODEL_NAMESPACE = {
	name: "bigmodel",
	description:
		"BigModel (Zhipu AI) tools: a billed web-search sidecar (CN-oriented engines " +
		"including Sogou and Quark) on the same API key as the bigmodel provider.",
	instructions:
		"bigmodel_search bills one search fee per call (¥0.01 std / ¥0.03 pro / ¥0.05 sogou|quark); " +
		"rejections are not billed. action=search returns structured results; action=ask returns a " +
		"search-grounded answer with sources from a free model. Not for local files or shell commands.",
};

type RegisterToolDef = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolExecuteParams = Parameters<RegisterToolDef["execute"]>;
type ToolUpdate = ToolExecuteParams[3];

/** Everything the registration needs from the host; injectable for tests. */
export interface SearchToolDeps {
	/** pi's agent dir (config + auth.json); resolved by index.ts at runtime. */
	agentDir(): string;
	/** Env reader, overridable in tests. */
	env?: EnvReader;
	/** Fetch, overridable in tests. */
	fetch?: typeof fetch;
}

/** Convenience for tests and the /bigmodel status page. */
export function searchStatus(cfg: SearchConfig): { exposure: SearchExposure; engine: SearchEngine; askModel: string } {
	return { exposure: resolveSearchExposure(cfg), engine: resolveSearchEngine(cfg), askModel: resolveAskModel(cfg) };
}
/**
 * Build the tool definition. Registration itself lives in index.ts so this
 * module stays free of runtime pi imports (the offline suite imports it).
 */
export function buildSearchTool(cfg: SearchConfig, deps: SearchToolDeps): RegisterToolDef {
	const env = deps.env ?? processEnv;
	const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
	const baseUrl = () => resolveBaseUrl("openai-completions", env);

	return {
		name: "bigmodel_search",
		label: "BigModel search",
		description:
			"Billed Zhipu web-search sidecar on the bigmodel API key. search: structured web results " +
			"(Sogou/Quark/Zhipu engines, strongest for the Chinese web). ask: a search-grounded answer " +
			"with sources, synthesized by a free model. One search fee per call; not for local files or shell.",
		promptSnippet:
			"bigmodel_search: billed Zhipu web-search sidecar; search=structured results, ask=grounded answer.",
		promptGuidelines: [
			"Use bigmodel_search only when current external information is needed and the built-in search is insufficient — for example for the Chinese web, where the Sogou and Quark engines are strongest.",
			"Prefer action=search for lookups; use action=ask when a synthesized, sourced answer is worth the same fee.",
		],
		parameters: BIGMODEL_SEARCH_PARAMETERS,
		annotations: BIGMODEL_SEARCH_ANNOTATIONS,
		outputSchema: BIGMODEL_SEARCH_OUTPUT_SCHEMA,
		executionMode: "parallel",
		exposure: resolveSearchExposure(cfg),
		namespace: BIGMODEL_NAMESPACE,
		async execute(
			_toolCallId: string,
			rawParams: SearchToolParams,
			signal: AbortSignal | undefined,
			_onUpdate: ToolUpdate,
		): Promise<AgentToolResult> {
			const params = rawParams as SearchToolParams;
			const action = params.action === "ask" ? "ask" : "search";
			const task = typeof params.task === "string" ? params.task.trim() : "";
			if (!task) throw new Error("bigmodel_search requires a non-empty task.");
			const engine = isSearchEngine(params.engine) ? params.engine : resolveSearchEngine(cfg);

			const key = readStoredApiKey(deps.agentDir()) ?? env("BIGMODEL_API_KEY");
			if (!key) {
				throw new Error(
					"Нет ключа BigModel. Выполните `/login bigmodel` или задайте BIGMODEL_API_KEY — " +
						"сайдкар поиска использует тот же ключ, что и провайдер.",
				);
			}

			if (action === "ask") {
				const model = resolveAskModel(cfg);
				const res = await postJson(`${baseUrl()}/chat/completions`, key, buildAskRequest(task, model, engine, { count: params.count }), signal, doFetch, 180_000);
				if (!res.ok) throw new Error(searchErrorMessage(res.status, res.body));
				const parsed = parseAskResponse(res.body);
				// The gateway silently skips the builtin search when the balance
				// cannot pay for it (measured 2026-10-09 on a zero-balance key: 200,
				// stale parametric answer, no `web_search[]`, no error). A silent
				// skip would sell an ungrounded answer as a search-grounded one —
				// fail loudly instead.
				if (!parsed.searched) {
					throw new Error(
						"BigModel: встроенный поиск не выполнился — в ответе нет массива web_search. " +
							"Наиболее вероятная причина — отсутствие средств: поиск в chat тарифицируется (¥0.01 std / ¥0.03 pro / ¥0.05 sogou|quark). " +
							`Ответ модели отброшен, он не подкреплён источниками. Пополните баланс: ${API_KEYS_URL}`,
					);
				}
				return {
					content: [{ type: "text", text: formatAskText(parsed, model, engine) }],
					structuredContent: {
						action,
						result: parsed.answer,
						sources: parsed.hits.map((h) => ({ title: h.title, url: h.url, snippet: truncate(h.snippet, SNIPPET_CHARS) })),
						engine,
						costNote: `¥${SEARCH_ENGINE_PRICES[engine].toFixed(2)} per search call; model ${model} is free`,
					},
					details: { action, engine, model, sourceCount: parsed.hits.length },
				};
			}

			const recency = (RECENCIES as readonly string[]).includes(String(params.recency)) ? (params.recency as Recency) : "noLimit";
			const contentSize = params.content_size === "high" ? "high" : "medium";
			const res = await postJson(
				`${baseUrl()}/web_search`,
				key,
				buildWebSearchRequest(task, engine, { count: params.count, recency, domain: params.domain, contentSize }),
				signal,
				doFetch,
				60_000,
			);
			if (!res.ok) throw new Error(searchErrorMessage(res.status, res.body));
			const parsed = parseWebSearchResponse(res.body);
			return {
				content: [{ type: "text", text: formatSearchText(parsed, engine) }],
				structuredContent: {
					action,
					result: parsed.hits.map((h, i) => `[${i + 1}] ${h.title}${h.url ? ` ${h.url}` : ""}`).join("\n") || "(no results)",
					sources: parsed.hits.map((h) => ({ title: h.title, url: h.url, snippet: truncate(h.snippet, SNIPPET_CHARS) })),
					engine,
					costNote: `¥${SEARCH_ENGINE_PRICES[engine].toFixed(2)} per call`,
					...(parsed.intent !== undefined ? { intent: parsed.intent } : {}),
				},
				details: { action, engine, resultCount: parsed.hits.length, ...(parsed.intent !== undefined ? { intent: parsed.intent } : {}) },
			};
		},
	} as unknown as RegisterToolDef;
}

/** POST JSON with the caller's signal plus a hard timeout; never throws fetch errors as-is. */
async function postJson(
	url: string,
	key: string,
	body: unknown,
	signal: AbortSignal | undefined,
	doFetch: typeof fetch,
	timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const r = await doFetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: combined,
	});
	const text = await r.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = { error: { message: text.slice(0, 300) } };
	}
	return { ok: r.ok, status: r.status, body: parsed };
}

/** The codemode announcement, shown in the system prompt while the tool is codemode-exposed. */
export function codemodeSectionText(): string {
	return (
		"bigmodel_search is callable from codemode scripts: a billed Zhipu web-search sidecar " +
		"(action=search: structured results; action=ask: grounded answer from a free model; " +
		"¥0.01-0.05 per call, Sogou/Quark engines cover the Chinese web)."
	);
}
