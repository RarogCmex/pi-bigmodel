/**
 * Catalog -> pi `Model` conversion.
 *
 * Three things happen here that pi cannot infer for an unlisted provider:
 *
 *  1. Currency. open.bigmodel.cn bills in CNY; pi's `ModelCost` is USD per
 *     million tokens. Converted at a documented rate, overridable via
 *     `BIGMODEL_CNY_PER_USD`. The default is deliberately the same rate as in
 *     our other CNY-billed gateway plugins, so cost reports stay comparable.
 *
 *  2. Request shape, per wire protocol. Both surfaces are OpenAI-flavoured and
 *     pi-ai 1.1.0 even auto-detects `open.bigmodel.cn` as zai for the
 *     completions adapter (`api/openai-completions.js:1227`), which gets
 *     `thinkingFormat: "zai"`, `maxTokensField: "max_tokens"`,
 *     `supportsStore: false` and `supportsDeveloperRole: false` right. What
 *     detection cannot know, and why the flags below are explicit:
 *      - `supportsReasoningEffort` detects to FALSE for every zai URL, but
 *        GLM-5.2 and the GLM-5.3 family do take `reasoning_effort` on the
 *        completions surface. It is pinned per entry from `ThinkingControl`,
 *        because the gateway silently ACCEPTS the field on models that ignore
 *        it (measured 2026-10-09 on glm-5.1/4.7/5v-turbo/4.7-flash), so
 *        acceptance is not evidence of support;
 *      - `zaiToolStream` detects to FALSE, but `tool_stream: true` is
 *        documented and accepted live;
 *      - `supportsStrictMode` detects to FALSE for every non-OpenAI URL (pi
 *        #9816). On completions `strict: true` is accepted, so it stays true;
 *        on Responses the `FunctionTool` schema has no `strict` field at all,
 *        so it is false there and pi omits the key;
 *      - `store` / `prompt_cache_retention` / grammar tools are absent from the
 *        completions spec. Probing showed the gateway accepts and ignores all
 *        three, so the reason is "not in the contract", not "rejected" —
 *        sending them would imply a cache control we do not have.
 *
 *  3. Thinking levels, per wire protocol. The same `ThinkingControl` produces
 *     different level maps on each surface, because the surfaces differ in what
 *     they can actually do — see `RESPONSES_EFFORT` and the measured evidence in
 *     `research/2026-10-09-refresh.md`. The short version: on completions "off"
 *     turns thinking off; on Responses nothing does, so "off" is not offered.
 *
 * Deliberately NOT set: `promptCache`. The gateway's cache is implicit and the
 * docs publish no TTL, so there is no honest number to put there — and pi's
 * cache warmer only fires for models that declare one
 * (`pi/dist/core/cache-warmer.js`: `ttlMs === undefined` → stop, "cache
 * lifetime unavailable"). Declaring a guessed TTL would make pi send extra
 * billed cache-warming requests for a cache it cannot keep alive. What the
 * Responses surface DOES give us is `prompt_cache_key` (documented as "cluster
 * routing, to raise the cache hit rate"), which pi fills from the session id
 * with no help from us. See «Кэш контекста» in the README.
 */

import type { Model, ModelCost, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
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

/** Base URL of each surface. Both live on open.bigmodel.cn but are not siblings. */
export const BASE_URL_BY_API: Readonly<Record<GatewayApi, string>> = {
	"openai-completions": "https://open.bigmodel.cn/api/paas/v4",
	"openai-responses": "https://open.bigmodel.cn/api/v1",
};

/** Kept as an alias: the completions URL is what `GET /models` and older docs cite. */
export const DEFAULT_BASE_URL = BASE_URL_BY_API["openai-completions"];
export const RESPONSES_BASE_URL = BASE_URL_BY_API["openai-responses"];

/**
 * The protocol every model is registered with unless the user says otherwise.
 * Responses is the default because it is the surface Zhipu is actively building
 * out (it alone documents `prompt_cache_key` and stateful multi-turn), and
 * because pi's own Responses adapter gives us reasoning-item replay for free.
 * `BIGMODEL_PROTOCOL=completions` switches the whole catalog back — the escape
 * hatch for anyone who needs a real thinking-off switch, which only the
 * completions surface has.
 */
export const DEFAULT_PROTOCOL: GatewayApi = "openai-responses";
export const PROTOCOL_ENV_VAR = "BIGMODEL_PROTOCOL";
export const BASE_URL_ENV_VAR = "BIGMODEL_BASE_URL";

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

/**
 * Which wire protocol to register. Accepts the pi api id or its short name
 * (`responses` / `completions`), trims, and is case-insensitive; anything
 * unrecognized falls back to the default rather than failing at startup, and
 * `resolveProtocol` reports what it chose so index.ts can say so out loud.
 */
export function resolveProtocol(
	env: (name: string) => string | undefined = (n) => process.env[n],
): { api: GatewayApi; requested?: string; recognized: boolean } {
	const raw = env(PROTOCOL_ENV_VAR)?.trim();
	if (!raw) return { api: DEFAULT_PROTOCOL, recognized: true };
	const lowered = raw.toLowerCase();
	if (lowered === "responses" || lowered === "openai-responses")
		return { api: "openai-responses", requested: raw, recognized: true };
	if (lowered === "completions" || lowered === "chat" || lowered === "openai-completions")
		return { api: "openai-completions", requested: raw, recognized: true };
	// `recognized: false` is what lets index.ts warn: falling back silently would
	// put a user who typed "completio" on the surface with no thinking off-switch.
	return { api: DEFAULT_PROTOCOL, requested: raw, recognized: false };
}

/**
 * Endpoint override for proxies or the international api.z.ai mirror. One
 * variable, applied to whichever surface is active: a proxy that fronts
 * open.bigmodel.cn front both paths, and two variables would invite a
 * half-migrated setup. Trailing slashes are trimmed.
 */
export function resolveBaseUrl(
	api: GatewayApi,
	env: (name: string) => string | undefined = (n) => process.env[n],
): string {
	const trimmed = env(BASE_URL_ENV_VAR)?.trim().replace(/\/+$/, "");
	return trimmed ? trimmed : BASE_URL_BY_API[api];
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

/** Completions flags shared by every catalog model. */
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

/**
 * Responses flags. Each one is a documented absence rather than a guess
 * (`openapi-responses.json`, read 2026-10-09):
 *  - `supportsStrictMode: false` — `FunctionTool` is `{type,name,description,parameters}`;
 *    there is no `strict`. The gateway accepts one and ignores it, and "accepts"
 *    has already proven meaningless on this platform, so pi omits it;
 *  - `supportsLongCacheRetention: false` — no `prompt_cache_retention` field
 *    (pi would otherwise send `"24h"` for `cacheRetention: "long"`);
 *  - `supportsExplicitPromptCacheMode: false` — no `prompt_cache_options`;
 *  - `supportsDeveloperRole: true` (pi's default, kept explicit) — the
 *    `InputMessage` role enum does list `developer`, and a developer-role item
 *    was accepted live;
 *  - `supportsMaxOutputTokens: true` — `max_output_tokens` is documented with a
 *    131072 ceiling, and pi's floor of 16 is far below every catalog maxTokens;
 *  - mid-conversation system messages, additional tools, tool search and
 *    grammar tools are not in the spec: all false, so pi folds later system
 *    messages into the leading one and sends plain function tools.
 *
 * `prompt_cache_key` needs no flag: pi fills it from the session id, and the
 * spec documents it as the cache-routing knob.
 */
const RESPONSES_COMPAT: OpenAIResponsesCompat = {
	supportsDeveloperRole: true,
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
	supportsExplicitPromptCacheMode: false,
	supportsMaxOutputTokens: true,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsAdditionalTools: false,
	supportsToolSearch: false,
};

/**
 * Level map for Responses models whose thinking cannot be switched off.
 *
 * Measured 2026-10-09 on GLM-4.7 / GLM-4.7-Flash: `reasoning.effort` "none"
 * (114 reasoning tokens), "minimal" (74), "low" (114), "medium" (113), "high"
 * (72), "max" (73), "xhigh" (56) and no reasoning field at all (105) are all
 * the same within noise; an undocumented `thinking:{type:"disabled"}` and
 * `do_sample:false` were accepted and ignored too. The completions surface,
 * probed in the same session, returns reasoning_tokens 0 for
 * `thinking:{type:"disabled"}`. So on Responses there is no "off" to offer, and
 * the remaining levels are passed through because the spec accepts them — while
 * the README says plainly that the effort knob is advisory there.
 */
export const RESPONSES_EFFORT = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} satisfies Model<GatewayApi>["thinkingLevelMap"];

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Per-model reasoning wiring derived from the catalog's `ThinkingControl`.
 *
 * Completions (`thinkingFormat: "zai"`): pi-ai sends
 * `thinking: {type:"enabled", clear_thinking:false}` when a reasoning level is
 * chosen and `{type:"disabled"}` when thinking is off (live-accepted for every
 * dynamic model probed, incl. glm-4.7-flash, and measured to zero out
 * reasoning_tokens). For forced thinkers, `off: null` hides "off" from the
 * picker — sending `disabled` to the GLM-5.3 family is a 400 (code 1210).
 *
 * Responses: `reasoning.effort` only. Same level maps for the GLM-5.3 family
 * (the gateway validates low|high|max there and 400s on the rest — measured),
 * `RESPONSES_EFFORT` for everything else that can think, which hides "off"
 * because nothing turns thinking off on that surface.
 *
 * `supportsReasoningEffort` is completions-only and must be pinned per entry: it
 * auto-detects to false for zai URLs, while the gateway errors on
 * `reasoning_effort` for nothing and silently ignores it for most models.
 */
/**
 * Per-entry reasoning wiring for the COMPLETIONS surface, where pi-ai sends
 * `thinking: {type:"enabled", clear_thinking:false}` for a chosen level and
 * `{type:"disabled"}` for "off" — measured to zero `reasoning_tokens` on this
 * gateway. `supportsReasoningEffort` must be pinned per entry: it auto-detects to
 * false for every zai URL, while the gateway errors on nothing and silently
 * ignores `reasoning_effort` for most models, so probing cannot settle it.
 */
function chatThinking(entry: CatalogEntry): {
	reasoning: boolean;
	compat: OpenAICompletionsCompat;
	levelMap?: Model<"openai-completions">["thinkingLevelMap"];
} {
	switch (entry.thinking.kind) {
		case "none":
			return { reasoning: false, compat: { supportsReasoningEffort: false } };
		case "dynamic":
			// "off" is real here: the gateway honours thinking.type=disabled
			// (GLM-4.7 and GLM-4.5V stopped being forced thinkers on 2026-10-09).
			return { reasoning: true, compat: { supportsReasoningEffort: false } };
		case "effort":
			return {
				reasoning: true,
				compat: { supportsReasoningEffort: true },
				levelMap: entry.thinking.levels,
			};
		case "always":
			return {
				reasoning: true,
				compat: { supportsReasoningEffort: entry.thinking.levels ? true : false },
				levelMap: entry.thinking.levels ?? { off: null },
			};
	}
}

/**
 * Per-entry reasoning wiring for the RESPONSES surface, where the only control is
 * `reasoning.effort` — and this gateway accepts every value and honours none of
 * them for turning thinking OFF (`none` measured at 114-118 reasoning tokens on
 * GLM-4.7, against 0 for completions' `thinking.type:"disabled"`). So `off` is
 * null wherever the model can think: pi hides a switch the gateway would ignore
 * and clamps "off" up to the lowest honest level instead of promising a saving.
 * GLM-5.3 keeps its own map because that family's effort enum IS enforced
 * (low|high|max; anything else is a 400).
 */
function responsesThinking(entry: CatalogEntry): {
	reasoning: boolean;
	levelMap?: Model<"openai-responses">["thinkingLevelMap"];
} {
	switch (entry.thinking.kind) {
		case "none":
			return { reasoning: false };
		case "dynamic":
		case "effort":
			return { reasoning: true, levelMap: RESPONSES_EFFORT };
		case "always":
			return { reasoning: true, levelMap: entry.thinking.levels ?? { off: null } };
	}
}

/** Fields identical on both surfaces; kept in one place so they cannot drift. */
function sharedFields(entry: CatalogEntry, baseUrl: string, rate: number) {
	return {
		id: entry.id,
		name: entry.name,
		provider: PROVIDER_ID,
		baseUrl,
		input: entry.input,
		cost: toCost(entry.cny, entry.cnyTiers, rate),
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		// Documented gateway caps so pi resizes before an image enters the
		// transcript; text-only entries leave it unset and pi uses its own default.
		...(entry.imageLimits ? { inputLimits: entry.imageLimits } : {}),
	};
}

export type BigModelModel = Model<GatewayApi>;

export function entryToModel(entry: CatalogEntry, baseUrl: string, rate: number, api: GatewayApi): BigModelModel {
	const shared = sharedFields(entry, baseUrl, rate);
	if (api === "openai-responses") {
		const { reasoning, levelMap } = responsesThinking(entry);
		const model: Model<"openai-responses"> = {
			...shared,
			api,
			reasoning,
			compat: { ...RESPONSES_COMPAT },
		};
		if (levelMap) model.thinkingLevelMap = levelMap;
		return model;
	}
	const { reasoning, compat, levelMap } = chatThinking(entry);
	const model: Model<"openai-completions"> = {
		...shared,
		api,
		reasoning,
		compat: { ...CHAT_COMPAT, ...compat },
	};
	if (levelMap) model.thinkingLevelMap = levelMap;
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
	if (/^glm-4\.5v/i.test(id)) return { contextWindow: 65_536, maxTokens: 16_384 };
	if (/^glm-4\.5/i.test(id)) return { contextWindow: 131_072, maxTokens: 131_072 };
	return { contextWindow: UNKNOWN_MODEL_DEFAULTS.contextWindow, maxTokens: UNKNOWN_MODEL_DEFAULTS.maxTokens };
}

/** Family-guessed registration for a gateway id this build has never seen. */
export function unknownModelToModel(id: string, baseUrl: string, api: GatewayApi): BigModelModel {
	const entry: CatalogEntry = {
		id,
		name: id,
		...guessWindows(id),
		input: guessInput(id),
		thinking: guessThinking(id),
		cny: { input: 0, output: 0, cacheRead: 0 },
	};
	// Guessed vision models get the endpoint-wide image caps: the 5 MB /
	// 6000×6000 limit is a property of the gateway, not of a model family, so an
	// unlisted VLM inherits it safely. Both surfaces were probed with a real
	// PNG on 2026-10-09 and both read the image.
	if (entry.input.includes("image")) entry.imageLimits = CN_IMAGE_LIMITS;
	const model = entryToModel(entry, baseUrl, DEFAULT_CNY_PER_USD, api);
	// Unknowns must not invent a price: pin the object so tests can
	// identity-compare against ZERO_COST.
	model.cost = { ...ZERO_COST };
	return model;
}

export function buildModels(api: GatewayApi, baseUrl: string, rate: number = cnyPerUsd()): BigModelModel[] {
	return CATALOG.map((entry) => entryToModel(entry, baseUrl, rate, api));
}
