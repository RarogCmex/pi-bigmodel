/**
 * Catalog -> pi `Model` conversion.
 *
 * Two things happen here that pi cannot infer for an unlisted provider:
 *
 *  1. Currency. open.bigmodel.cn bills in CNY; pi's `ModelCost` is USD per
 *     million tokens. Converted at a documented rate, overridable via
 *     `BIGMODEL_CNY_PER_USD` (same policy as pi-siliconflow).
 *
 *  2. Request shape. The gateway is OpenAI-chat-completions compatible, but
 *     pi's URL-based auto-detection classifies open.bigmodel.cn as a vanilla
 *     OpenAI endpoint, which is wrong in five places:
 *      - reasoning is toggled with a top-level `thinking: {type}` object —
 *        pi's "zai" thinkingFormat (same protocol as the built-in z.ai
 *        provider, live-verified on the CN endpoint 2026-09-24);
 *      - `reasoning_effort` is accepted only by GLM-5.2 and the GLM-5.3
 *        family, so `supportsReasoningEffort` is pinned per entry;
 *      - the documented roles are system/user/assistant/tool — no `developer`;
 *      - the reference documents `max_tokens`, not `max_completion_tokens`;
 *      - `store` / `prompt_cache_retention` / grammar tools are absent from
 *        the reference — never send them.
 *     `tool_stream: true` (compat `zaiToolStream`) is documented and was
 *     accepted in a live tool-call probe. `strict: true` on tools and
 *     `response_format` json_object were also accepted live.
 */

import type { Model, ModelCost, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import {
	CATALOG,
	GLM52_EFFORT,
	GLM53_EFFORT,
	type CatalogEntry,
	type CnyPrice,
	type CnyTier,
	type GatewayApi,
	type ThinkingControl,
} from "./catalog.ts";

export type { GatewayApi } from "./catalog.ts";

export const PROVIDER_ID = "bigmodel";
export const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

/**
 * CNY per 1 USD. Mid-market rate on 2026-09-15 (open.er-api.com), same source
 * date as pi-siliconflow's rate. Overridable because FX drifts.
 */
export const DEFAULT_CNY_PER_USD = 6.7252;

/** Precision for converted USD rates: enough that a ¥0.03 cache tier stays non-zero. */
const USD_DECIMALS = 1e6;

export function cnyPerUsd(env: (name: string) => string | undefined = (n) => process.env[n]): number {
	const raw = env("BIGMODEL_CNY_PER_USD");
	const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CNY_PER_USD;
}

export function cnyToUsd(cny: number, rate: number): number {
	return Math.round((cny / rate) * USD_DECIMALS) / USD_DECIMALS;
}

function toCost(cny: CnyPrice, tiers: readonly CnyTier[] | undefined, rate: number): ModelCost {
	const cost: ModelCost = {
		input: cnyToUsd(cny.input, rate),
		output: cnyToUsd(cny.output, rate),
		cacheRead: cnyToUsd(cny.cacheRead, rate),
		// BigModel publishes no cache-write price (cache storage is a limited-time free tier).
		cacheWrite: 0,
	};
	if (tiers?.length) {
		cost.tiers = [...tiers]
			.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
			.map((tier) => ({
				inputTokensAbove: tier.inputTokensAbove,
				input: cnyToUsd(tier.input, rate),
				output: cnyToUsd(tier.output, rate),
				cacheRead: cnyToUsd(tier.cacheRead, rate),
				cacheWrite: 0,
			}));
	}
	return cost;
}

/**
 * Compatibility flags shared by every catalog model. Per-entry thinking flags
 * are layered on top in `thinkingCompat`.
 */
const CHAT_COMPAT: OpenAICompletionsCompat = {
	maxTokensField: "max_tokens",
	thinkingFormat: "zai",
	supportsDeveloperRole: false,
	supportsStrictMode: true,
	supportsStore: false,
	supportsLongCacheRetention: false,
	supportsOpenAIGrammarTools: false,
	zaiToolStream: true,
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
};

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Per-model reasoning wiring derived from the catalog's `ThinkingControl`.
 *
 * With `thinkingFormat: "zai"`, pi-ai sends
 *   `thinking: {type:"enabled", clear_thinking:false}` when a reasoning level
 * is chosen and `{type:"disabled"}` when thinking is off (live-accepted by the
 * CN endpoint for every dynamic model probed, incl. glm-4.7-flash). For forced
 * thinkers, `off: null` in the level map hides "off" from the picker — sending
 * `disabled` to GLM-5.3/GLM-4.7/GLM-4.5V is a 400 (code 1210, probed).
 *
 * `supportsReasoningEffort` must be pinned per entry: it auto-detects to true
 * for reasoning models, but the gateway errors on `reasoning_effort` for
 * anything below GLM-5.2.
 */
function thinkingCompat(entry: CatalogEntry): {
	reasoning: boolean;
	compat: OpenAICompletionsCompat;
	thinkingLevelMap?: Model<GatewayApi>["thinkingLevelMap"];
} {
	const thinking = entry.thinking;
	switch (thinking.kind) {
		case "none":
			return { reasoning: false, compat: { supportsReasoningEffort: false } };
		case "dynamic":
			return { reasoning: true, compat: { supportsReasoningEffort: false } };
		case "effort":
			return {
				reasoning: true,
				compat: { supportsReasoningEffort: true },
				thinkingLevelMap: thinking.levels,
			};
		case "always":
			return {
				reasoning: true,
				compat: { supportsReasoningEffort: thinking.levels ? true : false },
				thinkingLevelMap: thinking.levels ?? { off: null },
			};
	}
}

export type BigModelModel = Model<GatewayApi>;

export function entryToModel(entry: CatalogEntry, baseUrl: string, rate: number): BigModelModel {
	const { reasoning, compat, thinkingLevelMap: map } = thinkingCompat(entry);
	const model: BigModelModel = {
		id: entry.id,
		name: entry.name,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl,
		reasoning,
		input: entry.input,
		cost: toCost(entry.cny, entry.cnyTiers, rate),
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: { ...CHAT_COMPAT, ...compat },
	};
	if (map) model.thinkingLevelMap = map;
	return model;
}

/**
 * Conservative shape for a model whose family we do not recognise. Cost stays
 * zero so pi reports $0.00 rather than an invented number, and the context
 * window is small enough that compaction fires early instead of overflowing.
 * Recognised families inherit sibling defaults — see `guessThinking` /
 * `guessWindows` / `guessInput`.
 */
export const UNKNOWN_MODEL_DEFAULTS = {
	contextWindow: 32_768,
	maxTokens: 8_192,
} as const;

/** Family-guessed thinking control for an unlisted id. */
export function guessThinking(id: string): ThinkingControl {
	if (/^glm-5\.3/i.test(id)) return { kind: "always", levels: GLM53_EFFORT };
	if (/^glm-5\.2/i.test(id)) return { kind: "effort", levels: GLM52_EFFORT };
	if (/^glm-5/i.test(id)) return { kind: "dynamic" };
	if (/^glm-4\.[5-9]/i.test(id)) return { kind: "dynamic" };
	if (/^glm-4\./i.test(id)) return { kind: "none" };
	return { kind: "none" };
}

export function guessInput(id: string): ("text" | "image")[] {
	// VLM naming: GLM-x.yV, GLM-5V-…, …-Thinking-… (4.1V family is vision-only).
	if (/glm-\d[\d.]*v/i.test(id) || /glm-5v/i.test(id)) return ["text", "image"];
	return ["text"];
}

export function guessWindows(id: string): { contextWindow: number; maxTokens: number } {
	if (/^glm-5\.3|^glm-5\.2/i.test(id)) return { contextWindow: 1_048_576, maxTokens: 131_072 };
	if (/^glm-5/i.test(id)) return { contextWindow: 204_800, maxTokens: 131_072 };
	if (/^glm-4\.[67]/i.test(id)) return { contextWindow: 204_800, maxTokens: 131_072 };
	if (/^glm-4\.5/i.test(id)) return { contextWindow: 131_072, maxTokens: 98_304 };
	return { contextWindow: UNKNOWN_MODEL_DEFAULTS.contextWindow, maxTokens: UNKNOWN_MODEL_DEFAULTS.maxTokens };
}

/** Family-guessed registration for a gateway id this build has never seen. */
export function unknownModelToModel(id: string, baseUrl: string): BigModelModel {
	const entry: CatalogEntry = {
		id,
		name: id,
		...guessWindows(id),
		input: guessInput(id),
		thinking: guessThinking(id),
		cny: { input: 0, output: 0, cacheRead: 0 },
	};
	const model = entryToModel(entry, baseUrl, DEFAULT_CNY_PER_USD);
	// Unknowns must not invent a price: pin the object so tests can
	// identity-compare against ZERO_COST.
	model.cost = { ...ZERO_COST };
	return model;
}

export function buildModels(baseUrl: string, rate: number = cnyPerUsd()): BigModelModel[] {
	return CATALOG.map((entry) => entryToModel(entry, baseUrl, rate));
}
