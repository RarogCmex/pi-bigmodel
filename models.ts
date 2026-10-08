/**
 * Catalog -> pi `Model` conversion.
 *
 * Two things happen here that pi cannot infer for an unlisted provider:
 *
 *  1. Currency. open.bigmodel.cn bills in CNY; pi's `ModelCost` is USD per
 *     million tokens. Converted at a documented rate, overridable via
 *     `BIGMODEL_CNY_PER_USD`. The default is deliberately the same rate as in
 *     our other CNY-billed gateway plugins, so cost reports stay comparable.
 *
 *  2. Request shape. The gateway is OpenAI-chat-completions compatible. Since
 *     pi-ai 1.1.0 its URL auto-detection recognises `open.bigmodel.cn` as zai
 *     (`api/openai-completions.js:1227`), which already gets four things right:
 *     `thinkingFormat: "zai"`, `maxTokensField: "max_tokens"`,
 *     `supportsStore: false`, `supportsDeveloperRole: false`. What detection
 *     still gets wrong for this endpoint, and why the flags below are explicit:
 *      - `supportsReasoningEffort` detects to FALSE for every zai URL, but
 *        GLM-5.2 and the GLM-5.3 family do take `reasoning_effort` (docs +
 *        live); it is pinned per entry from `ThinkingControl`, because the
 *        gateway silently accepts the field on models that ignore it and
 *        acceptance therefore proves nothing;
 *      - `zaiToolStream` detects to FALSE, but `tool_stream: true` is documented
 *        and was accepted live (2026-09-24, re-checked 2026-10-09);
 *      - `supportsStrictMode` detects to FALSE for every non-OpenAI URL (pi
 *        #9816), but `strict: true` tool schemas are accepted live.
 *     `supportsLongCacheRetention`/`supportsStore` stay false on purpose: the
 *     chat-completions spec (openapi.json, read 2026-10-09) has no `store`,
 *     `prompt_cache_key` or `prompt_cache_retention` field. Probing showed the
 *     gateway ACCEPTS all three and ignores them (200, no behaviour change), so
 *     the reason is "not in the contract", not "rejected" — sending them would
 *     only imply a cache control we do not have.
 *
 *  3. Image limits. `Model.inputLimits` (pi ≥ 1.0) carries the endpoint's
 *     documented per-image caps so pi resizes before an image enters the
 *     transcript instead of letting the gateway reject it.
 *
 * Deliberately NOT set: `promptCache`. The gateway's cache is implicit and the
 * docs publish no TTL, so there is no honest number to put there — and pi's
 * cache warmer only fires for models that declare one
 * (`pi/dist/core/cache-warmer.js`: `ttlMs === undefined` → stop, "cache
 * lifetime unavailable"). Declaring a guessed TTL would make pi send extra
 * billed cache-warming requests for a cache it cannot keep alive. See the
 * «Кэш контекста» section of the README for the measured behaviour.
 */

import type { Model, ModelCost, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import {
	CATALOG,
	CN_IMAGE_LIMITS,
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
 * CNY per 1 USD. Mid-market rate observed 2026-09-15 (open.er-api.com); the same
 * source date is used for every CNY-billed gateway plugin we ship, so their cost
 * reports stay comparable. Overridable because FX drifts.
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
 * are layered on top in `thinkingCompat`. The header comment explains which of
 * these pi-ai 1.1.0 would already detect for `open.bigmodel.cn` and which are
 * here because detection gets them wrong.
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
	if (entry.imageLimits) model.inputLimits = entry.imageLimits;
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
	// Guessed vision models get the endpoint-wide image caps: the 5 MB /
	// 6000×6000 limit is a property of the chat-completions contract, not of a
	// model family, so an unlisted VLM inherits it safely.
	if (entry.input.includes("image")) entry.imageLimits = CN_IMAGE_LIMITS;
	const model = entryToModel(entry, baseUrl, DEFAULT_CNY_PER_USD);
	// Unknowns must not invent a price: pin the object so tests can
	// identity-compare against ZERO_COST.
	model.cost = { ...ZERO_COST };
	return model;
}

export function buildModels(baseUrl: string, rate: number = cnyPerUsd()): BigModelModel[] {
	return CATALOG.map((entry) => entryToModel(entry, baseUrl, rate));
}
