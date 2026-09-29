/**
 * Curated BigModel (open.bigmodel.cn) catalog.
 *
 * Data provenance — every field was read from public Zhipu pages on 2026-09-24
 * and cross-checked live against the gateway:
 *
 *   ids, contextWindow,    https://docs.bigmodel.cn/cn/guide/start/model-overview.md
 *   maxTokens, `input`
 *   `cny` prices, tiers    https://docs.bigmodel.cn/cn/guide/start/pricing.md
 *                          (CNY per 1M tokens, cache = 缓存命中; 缓存存储 is
 *                          currently 限时免费, so cacheWrite stays 0)
 *   thinking semantics     https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md
 *                          (thinking.type enabled/disabled; reasoning_effort is
 *                          GLM-5.2+ only; GLM-5.3 & GLM-4.7 flagships are forced
 *                          thinkers — `disabled` returns 400 code 1210, probed)
 *
 * Models are omitted on purpose (README "Намеренно не включены"):
 *   - `glm-4v-flash` (16K ctx / 1K out — useless for an agent)
 *   - `glm-4-long` (1M ctx but 4K out, GLM-4 generation, no thinking)
 *   - AutoGLM-Phone (phone-assistant VLM, 20K/2K)
 *   - non-chat modalities (embeddings, rerank, OCR, GLM-Image/CogView/CogVideo,
 *     TTS/ASR/Realtime) — not usable through chat completions for an agent.
 *
 * `GET /models` (live, 2026-09-24) currently returns exactly:
 *   glm-4.5, glm-4.5-air, glm-4.6, glm-4.7, glm-5, glm-5-turbo, glm-5.1,
 *   glm-5.2, glm-5.3, glm-5.3-flash, glm-5.3-flashx
 * — free flash models and VLMs are NOT listed there but answer /chat/completions,
 * which is why discovery is an additive overlay, never a replacement.
 *
 * GLM-4.6 / GLM-4.5 / GLM-4.5-AirX are priced at zero with a priceNote: the
 * current public price page no longer lists them (only private instances), and
 * inventing a CNY rate would corrupt cost reports.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

export type GatewayApi = "openai-completions";

/** CNY per 1M tokens. `cacheRead` is the 缓存命中 column; 0 when "不支持"/"-". */
export interface CnyPrice {
	input: number;
	output: number;
	cacheRead: number;
}

/** A priced input-size band (pi's `ModelCost.tiers` semantics: the highest
 *  matching input threshold applies to the full request). */
export interface CnyTier extends CnyPrice {
	inputTokensAbove: number;
}

/**
 * How a model exposes reasoning on the BigModel gateway.
 *
 * Verified against docs + live probes (2026-09-24):
 *  - `none`    no thinking params at all (GLM-4 generation);
 *  - `dynamic` hybrid: `thinking.type` enabled/disabled, no effort control
 *              (GLM-5.1/5/5-Turbo, GLM-4.6/4.5 families, most VLMs);
 *  - `effort`  dynamic + `reasoning_effort` (GLM-5.2 only: none|minimal|low|
 *              medium|high|xhigh|max, server maps low/medium→high, xhigh→max);
 *  - `always`  forced thinker: `disabled` → 400 "该模型始终思考" (GLM-5.3
 *              family with low/high/max effort; GLM-4.7, GLM-4.5V, 4.1V-Thinking
 *              without effort).
 */
export type ThinkingControl =
	| { kind: "none" }
	| { kind: "dynamic" }
	| { kind: "effort"; levels: ThinkingLevelMap }
	| { kind: "always"; levels?: ThinkingLevelMap };

export interface CatalogEntry {
	/** Exact BigModel model id. */
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	thinking: ThinkingControl;
	cny: CnyPrice;
	cnyTiers?: CnyTier[];
	/**
	 * Free-text pricing caveat for maintainers and for the README tables.
	 * Deliberately NOT exposed to pi: `Model` has no notes field, so
	 * `entryToModel` never copies it — a caveat that must reach the user has to
	 * be written into the README (see the † footnote there).
	 */
	priceNote?: string;
}

/** Context/output sizes as published, expanded from the "200K / 128K" display form. */
const CTX_1M = 1_048_576;
const CTX_200K = 204_800;
const CTX_128K = 131_072;
const CTX_64K = 65_536;
const OUT_128K = 131_072;
const OUT_96K = 98_304;
const OUT_32K = 32_768;
const OUT_16K = 16_384;
/** Input threshold (tokens) where BigModel's higher price band starts. */
const TIER_32K = 32_768;

/** GLM-5.3 family: forced thinking, effort is exactly low | high | max (docs). */
export const GLM53_EFFORT = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} satisfies ThinkingLevelMap;

/** GLM-5.2: the only model that accepts the full reasoning_effort scale (docs). */
export const GLM52_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} satisfies ThinkingLevelMap;

/** Forced thinker without effort control: hide "off" only. */
export const ALWAYS_THINKING: ThinkingLevelMap = { off: null };

/** Bigger input band used by 5.1/5/5-Turbo/4.7/4.6V/4.5V style tiered pricing. */
function tier32K(cny: CnyPrice): CnyTier {
	return { inputTokensAbove: TIER_32K, ...cny };
}

/** Same-image limits the built-in zai catalog publishes for GLM-5.3-Flash. */
export const GLM53_FLASH_IMAGE_LIMITS = {
	images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
};

export const CATALOG: readonly CatalogEntry[] = [
	// ── Flagship text ───────────────────────────────────────────────────
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: CTX_1M,
		maxTokens: OUT_128K,
		input: ["text"],
		thinking: { kind: "always", levels: GLM53_EFFORT },
		cny: { input: 8, output: 28, cacheRead: 2 },
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		contextWindow: CTX_1M,
		maxTokens: OUT_128K,
		input: ["text", "image"],
		thinking: { kind: "always", levels: GLM53_EFFORT },
		cny: { input: 0.8, output: 2.8, cacheRead: 0.23 },
	},
	{
		id: "glm-5.3-flashx",
		name: "GLM-5.3-FlashX",
		contextWindow: CTX_1M,
		maxTokens: OUT_128K,
		input: ["text", "image"],
		thinking: { kind: "always", levels: GLM53_EFFORT },
		cny: { input: 2, output: 7, cacheRead: 0.57 },
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: CTX_1M,
		maxTokens: OUT_128K,
		input: ["text"],
		thinking: { kind: "effort", levels: GLM52_EFFORT },
		cny: { input: 8, output: 28, cacheRead: 2 },
	},

	// ── Text, tiered by input size ──────────────────────────────────────
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: CTX_200K,
		maxTokens: OUT_128K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 6, output: 24, cacheRead: 1.3 },
		cnyTiers: [tier32K({ input: 8, output: 28, cacheRead: 2 })],
	},
	{
		id: "glm-5-turbo",
		name: "GLM-5-Turbo",
		contextWindow: CTX_200K,
		maxTokens: OUT_128K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 5, output: 22, cacheRead: 1.2 },
		cnyTiers: [tier32K({ input: 7, output: 26, cacheRead: 1.8 })],
	},
	{
		id: "glm-5",
		name: "GLM-5",
		contextWindow: CTX_200K,
		maxTokens: OUT_128K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 4, output: 18, cacheRead: 1 },
		cnyTiers: [tier32K({ input: 6, output: 22, cacheRead: 1.5 })],
	},
	{
		// Output-band pricing (<0.2K vs ≥0.2K output) is not representable in
		// pi's input-threshold tiers; the ≥0.2K band is the base since an agent
		// always emits more than 200 tokens.
		id: "glm-4.7",
		name: "GLM-4.7",
		contextWindow: CTX_200K,
		maxTokens: OUT_128K,
		input: ["text"],
		thinking: { kind: "always" },
		cny: { input: 3, output: 14, cacheRead: 0.6 },
		cnyTiers: [tier32K({ input: 4, output: 16, cacheRead: 0.8 })],
		priceNote: "базовая полоса = вывод ≥0.2K; полоса вывода <0.2K дешевле (2/8)",
	},
	{
		id: "glm-4.7-flashx",
		name: "GLM-4.7-FlashX",
		contextWindow: CTX_200K,
		maxTokens: OUT_128K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 0.5, output: 3, cacheRead: 0.1 },
	},
	{
		id: "glm-4.7-flash",
		name: "GLM-4.7-Flash (free)",
		contextWindow: CTX_200K,
		maxTokens: OUT_128K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 0, output: 0, cacheRead: 0 },
	},
	{
		id: "glm-4.6",
		name: "GLM-4.6",
		contextWindow: CTX_200K,
		maxTokens: OUT_128K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 0, output: 0, cacheRead: 0 },
		priceNote: "исчез из публичного прайса (сент-2026) — цена неизвестна, отчёты покажут ¥0",
	},
	{
		id: "glm-4.5",
		name: "GLM-4.5",
		contextWindow: CTX_128K,
		maxTokens: OUT_96K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 0, output: 0, cacheRead: 0 },
		priceNote: "исчез из публичного прайса (сент-2026) — цена неизвестна, отчёты покажут ¥0",
	},
	{
		// Same output-band caveat as glm-4.7: base = the ≥0.2K output band.
		id: "glm-4.5-air",
		name: "GLM-4.5-Air",
		contextWindow: CTX_128K,
		maxTokens: OUT_96K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 0.8, output: 6, cacheRead: 0.16 },
		cnyTiers: [tier32K({ input: 1.2, output: 8, cacheRead: 0.24 })],
		priceNote: "базовая полоса = вывод ≥0.2K; полоса вывода <0.2K дешевле (0.8/2)",
	},
	{
		id: "glm-4.5-airx",
		name: "GLM-4.5-AirX",
		contextWindow: CTX_128K,
		maxTokens: OUT_96K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 0, output: 0, cacheRead: 0 },
		priceNote: "исчез из публичного прайса (сент-2026) — цена неизвестна, отчёты покажут ¥0",
	},
	{
		id: "glm-4.5-flash",
		name: "GLM-4.5-Flash (free)",
		contextWindow: CTX_128K,
		maxTokens: OUT_96K,
		input: ["text"],
		thinking: { kind: "dynamic" },
		cny: { input: 0, output: 0, cacheRead: 0 },
	},
	{
		id: "glm-4-flash-250414",
		name: "GLM-4-Flash (free)",
		contextWindow: CTX_128K,
		maxTokens: OUT_16K,
		input: ["text"],
		thinking: { kind: "none" },
		cny: { input: 0, output: 0, cacheRead: 0 },
	},
	{
		id: "glm-4-flashx-250414",
		name: "GLM-4-FlashX",
		contextWindow: CTX_128K,
		maxTokens: OUT_16K,
		input: ["text"],
		thinking: { kind: "none" },
		cny: { input: 0.1, output: 0.1, cacheRead: 0.05 },
	},

	// ── Vision ──────────────────────────────────────────────────────────
	{
		id: "glm-5v-turbo",
		name: "GLM-5V-Turbo",
		contextWindow: CTX_200K,
		maxTokens: OUT_128K,
		input: ["text", "image"],
		thinking: { kind: "dynamic" },
		cny: { input: 5, output: 22, cacheRead: 1.2 },
		cnyTiers: [tier32K({ input: 7, output: 26, cacheRead: 1.8 })],
	},
	{
		id: "glm-4.6v",
		name: "GLM-4.6V",
		contextWindow: CTX_128K,
		maxTokens: OUT_32K,
		input: ["text", "image"],
		thinking: { kind: "dynamic" },
		cny: { input: 1, output: 3, cacheRead: 0.2 },
		cnyTiers: [tier32K({ input: 2, output: 6, cacheRead: 0.4 })],
	},
	{
		id: "glm-4.6v-flashx",
		name: "GLM-4.6V-FlashX",
		contextWindow: CTX_128K,
		maxTokens: OUT_32K,
		input: ["text", "image"],
		thinking: { kind: "dynamic" },
		cny: { input: 0.15, output: 1.5, cacheRead: 0.03 },
		cnyTiers: [tier32K({ input: 0.3, output: 3, cacheRead: 0.03 })],
	},
	{
		id: "glm-4.6v-flash",
		name: "GLM-4.6V-Flash (free)",
		contextWindow: CTX_128K,
		maxTokens: OUT_32K,
		input: ["text", "image"],
		thinking: { kind: "dynamic" },
		cny: { input: 0, output: 0, cacheRead: 0 },
	},
	{
		id: "glm-4.5v",
		name: "GLM-4.5V",
		contextWindow: CTX_64K,
		maxTokens: OUT_32K,
		input: ["text", "image"],
		thinking: { kind: "always" },
		cny: { input: 2, output: 6, cacheRead: 0.4 },
		cnyTiers: [tier32K({ input: 4, output: 12, cacheRead: 0.8 })],
	},
	{
		id: "glm-4.1v-thinking-flash",
		name: "GLM-4.1V-Thinking-Flash (free)",
		contextWindow: CTX_64K,
		maxTokens: OUT_16K,
		input: ["text", "image"],
		thinking: { kind: "always" },
		cny: { input: 0, output: 0, cacheRead: 0 },
	},
	{
		id: "glm-4.1v-thinking-flashx",
		name: "GLM-4.1V-Thinking-FlashX",
		contextWindow: CTX_64K,
		maxTokens: OUT_16K,
		input: ["text", "image"],
		thinking: { kind: "always" },
		cny: { input: 2, output: 2, cacheRead: 0 },
	},
];

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
	CATALOG.map((entry) => [entry.id, entry]),
);

/** Image-input models that ship documented resize limits (same model as z.ai's). */
export const IMAGE_LIMITS_BY_ID: ReadonlyMap<string, object> = new Map([
	["glm-5.3-flash", GLM53_FLASH_IMAGE_LIMITS],
	["glm-5.3-flashx", GLM53_FLASH_IMAGE_LIMITS],
]);
