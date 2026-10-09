/**
 * Curated BigModel (open.bigmodel.cn) catalog.
 *
 * Data provenance — every field was read from public Zhipu pages (2026-09-24,
 * re-read 2026-10-09) and cross-checked live against the gateway:
 *
 *   ids, contextWindow,    https://docs.bigmodel.cn/cn/guide/start/model-overview.md
 *   maxTokens, `input`
 *   `cny` prices, tiers    https://docs.bigmodel.cn/cn/guide/start/pricing.md
 *                          (CNY per 1M tokens, cache = 缓存命中; 缓存存储 is
 *                          currently 限时免费, so cacheWrite stays 0)
 *   thinking semantics     https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md
 *                          + …/capabilities/thinking-mode.md
 *   request params         https://docs.bigmodel.cn/openapi/openapi.json
 *                          (ChatCompletionTextRequest / …VisionRequest)
 *   image limits           openapi.json → VisionMultimodalContentItem
 *   error codes            https://docs.bigmodel.cn/cn/api/api-code.md
 *
 * Output caps re-measured live 2026-10-09 from free rejections
 * (`max_tokens: 99999999` → 400 code 1210 「限制数值范围[1,N]») on BOTH surfaces —
 * chat completions and /api/v1/responses agree on every id:
 *   131072  glm-4.5, 4.6, 4.7, 4.7-flash, 4.7-flashx, 5, 5.1, 5.2, 5.3,
 *           5.3-flash, 5.3-flashx, 5-turbo, 5v-turbo
 *   98304   glm-4.5-air, 4.5-airx, 4.5-flash
 *   32768   glm-4.6v, 4.6v-flashx, 4.6v-flash
 *   16384   glm-4.5v, 4.1v-thinking-flash, 4.1v-thinking-flashx,
 *           4-flash-250414, 4-flashx-250414
 * Two catalog entries disagreed and were corrected: glm-4.5 (96K -> 128K) and
 * glm-4.5v (32K -> 16K).
 *
 * Thinking was re-probed live 2026-10-09 (`thinking:{type:"disabled"}`, then a
 * 64-token generation to see whether reasoning actually stopped):
 *   - GLM-5.3 / 5.3-Flash / 5.3-FlashX → 400 code 1210 「该模型始终思考」 (forced);
 *   - GLM-4.7 and GLM-4.5V → 200 and reasoning_tokens 0, i.e. thinking DOES turn
 *     off now. Both were forced thinkers on 2026-09-24; GLM-4.7 gained 轮级思考
 *     (turn-level thinking) per thinking-mode.md. They are `dynamic` now, so pi
 *     offers "off" for them. The prose in thinking.md still calls them 强制思考 —
 *     the gateway disagrees, and the gateway is what pi talks to;
 *   - GLM-4.1V-Thinking-Flash/FlashX → 200, but the answer still arrives with a
 *     `<think>` block inside `content` (no reasoning_content, no
 *     reasoning_tokens) whether thinking is enabled or not. "off" would be a
 *     lie, so they stay `always`.
 *   Everything else accepted `disabled` and produced no reasoning (dynamic).
 *
 * Note on the OpenAPI enums (2026-10-09): the documented model enum for text
 * requests omits `glm-4.5` and the vision enum omits `glm-4.5v`, and neither
 * appears in model-overview — yet `GET /models` still lists `glm-4.5` and both
 * answer /chat/completions with 200 and echo their own id (no silent rerouting).
 * They stay in the catalog; the enum is a docs artifact, not an entitlement list.
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

import type { ModelInputLimits, ThinkingLevelMap } from "@earendil-works/pi-ai";

/**
 * The two wire protocols this gateway serves, and the only two this plugin
 * registers. Both were probed live 2026-10-09 (research/):
 *
 *  - `openai-completions` — `POST {base}/chat/completions`, the surface this
 *    plugin shipped with. Thinking is a first-class request field
 *    (`thinking:{type:"enabled"|"disabled"}`), so "off" really is off
 *    (measured: reasoning_tokens 0), and errors carry numeric business codes
 *    (1113, 1261, 1000…).
 *  - `openai-responses` — `POST https://open.bigmodel.cn/api/v1/responses`,
 *    OpenAI-Responses-shaped (`input`, `reasoning.effort`, `max_output_tokens`,
 *    output items, `response.*` stream events). It is the DEFAULT here because
 *    it is the only surface that documents `prompt_cache_key` (cluster routing
 *    for cache hits) and `previous_response_id`. The trade-off, measured: it has
 *    no working thinking switch — `reasoning.effort:"none"`, an undocumented
 *    `thinking:{type:"disabled"}` and `do_sample:false` were all accepted and
 *    all ignored (GLM-4.7 still spent 93-118 reasoning tokens), so "off" is
 *    hidden from pi on this surface instead of pretending to work. Its errors
 *    use OpenAI-style string codes (`insufficient_quota`,
 *    `context_length_exceeded`, `overloaded`) and — unlike every other surface
 *    here — an auth failure arrives as HTTP 200 with an in-band
 *    `{code,msg,success:false}` body (see errors.ts `remediateInBandResponse`).
 *
 * Every catalog id exists on both (free availability sweep, 2026-10-09: all 24
 * answered the `max_output_tokens` rejection rather than `model_not_found`, and
 * the disclosed output caps agreed between the two surfaces on every id).
 */
export type GatewayApi = "openai-completions" | "openai-responses";

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
 * Verified against docs + live probes (2026-09-24, re-probed 2026-10-09):
 *  - `none`    no thinking params at all (GLM-4 generation);
 *  - `dynamic` hybrid: `thinking.type` enabled/disabled, no effort control
 *              (GLM-5.1/5/5-Turbo, GLM-4.7, GLM-4.6/4.5 families, GLM-4.5V,
 *              most VLMs). GLM-4.7 and GLM-4.5V moved here from `always`:
 *              `disabled` is accepted and honoured now (measured, not doc-derived
 *              — thinking.md still calls them 强制思考);
 *  - `effort`  dynamic + `reasoning_effort` (GLM-5.2 only: none|minimal|low|
 *              medium|high|xhigh|max, server maps low/medium→high, xhigh→max);
 *  - `always`  "off" is not a real option. Two different reasons:
 *              GLM-5.3/5.3-Flash/5.3-FlashX reject `disabled` with 400 code 1210
 *              「该模型始终思考」 and take low/high/max effort; GLM-4.1V-Thinking
 *              accepts `disabled` but thinks anyway, emitting `<think>` inside
 *              `content` (no reasoning_content), so hiding "off" is the honest
 *              mapping for a different cause.
 *
 * `reasoning_effort` is GLM-5.2+ only per the docs, and the gateway silently
 * ACCEPTS it on models that ignore it (probed 2026-10-09: glm-5.1, glm-4.7,
 * glm-5v-turbo, glm-4.7-flash all answered 200 to `reasoning_effort`), so
 * acceptance proves nothing — `supportsReasoningEffort` stays pinned per entry
 * from the documentation, and GLM-5.3's low/high/max restriction IS enforced
 * (`medium` → 400/1210, probed).
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
	/**
	 * Gateway input limits for image-capable models, published to pi as
	 * `Model.inputLimits` so it resizes before an image enters the transcript.
	 * Text-only entries leave it unset and pi applies its own default profile.
	 */
	imageLimits?: ModelInputLimits;
	/** Set when the vendor announced retirement without a date. README-only. */
	retiring?: string;
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

/**
 * Image limits as the CN endpoint documents them (openapi.json →
 * VisionMultimodalContentItem, read 2026-10-09): every image ≤ 5 MB and
 * ≤ 6000×6000 px, jpg/png/jpeg.
 *
 * pi's `maxBytes` is the BASE64 payload size, not the file size
 * (`pi/dist/utils/image-resize-core.js`: "4.5MB of base64 payload"), so
 * 5_000_000 keeps the decoded image under the documented 5 MB whichever way the
 * gateway measures it. The resize profile is deliberately the documented
 * ceiling rather than pi's 2000×2000 default: GLM-5.3-Flash is sold for
 * screenshot/GUI work and downscaling to 2000 px destroys small UI text. The
 * trade-off is that bigger images cost more input tokens — override per model in
 * `~/.pi/agent/models.json` (`inputLimits.images.resize`) if you want cheaper.
 */
const CN_IMAGE_RESIZE = {
	resize: { maxWidth: 6000, maxHeight: 6000, maxBytes: 5_000_000, jpegQuality: 80 },
} as const;

/** Models the docs cap at 50 images per request (5.3-Flash/5V-Turbo/4.6V/4.5V). */
export const CN_IMAGE_LIMITS_50: ModelInputLimits = {
	images: { ...CN_IMAGE_RESIZE, maxPerRequest: 50 },
};

/** Image models with no published per-request count (GLM-4.1V-Thinking family). */
export const CN_IMAGE_LIMITS: ModelInputLimits = { images: { ...CN_IMAGE_RESIZE } };

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
		imageLimits: CN_IMAGE_LIMITS_50,
		thinking: { kind: "always", levels: GLM53_EFFORT },
		cny: { input: 0.8, output: 2.8, cacheRead: 0.23 },
	},
	{
		id: "glm-5.3-flashx",
		name: "GLM-5.3-FlashX",
		contextWindow: CTX_1M,
		maxTokens: OUT_128K,
		input: ["text", "image"],
		imageLimits: CN_IMAGE_LIMITS_50,
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
		// Forced thinker on 2026-09-24; `disabled` accepted and honoured live
		// 2026-10-09 (reasoning_tokens 0) — GLM-4.7 has turn-level thinking.
		thinking: { kind: "dynamic" },
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
		// The docs give 96K for the "GLM-4.5 family", and glm-4.5-air/-airx/-flash
		// do disclose [1,98304]; this id discloses [1,131072] on BOTH surfaces
		// (free rejection probe, 2026-10-09). The gateway wins.
		maxTokens: OUT_128K,
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
		// model-overview marks it 「（即将下线）」 as of 2026-10-09 and publishes no
		// date; the 即将弃用模型 table does not list it either. Kept until the
		// gateway actually rejects it — it still answered 200 live.
		retiring: "помечена «即将下线» в model-overview (2026-10-09), дата не опубликована",
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
		imageLimits: CN_IMAGE_LIMITS_50,
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
		imageLimits: CN_IMAGE_LIMITS_50,
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
		imageLimits: CN_IMAGE_LIMITS_50,
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
		imageLimits: CN_IMAGE_LIMITS_50,
		thinking: { kind: "dynamic" },
		cny: { input: 0, output: 0, cacheRead: 0 },
	},
	{
		id: "glm-4.5v",
		name: "GLM-4.5V",
		contextWindow: CTX_64K,
		// Was OUT_32K. Both surfaces disclose [1,16384] (2026-10-09) and the
		// vision request spec says 「GLM-4.5V最大支持16K输出长度」 — the catalog entry
		// was simply wrong, and pi would have requested outputs the gateway 400s.
		maxTokens: OUT_16K,
		input: ["text", "image"],
		imageLimits: CN_IMAGE_LIMITS_50,
		// Forced thinker on 2026-09-24; `disabled` accepted and honoured live
		// 2026-10-09 (reasoning_tokens 0), so "off" is a real option again.
		thinking: { kind: "dynamic" },
		cny: { input: 2, output: 6, cacheRead: 0.4 },
		cnyTiers: [tier32K({ input: 4, output: 12, cacheRead: 0.8 })],
	},
	{
		id: "glm-4.1v-thinking-flash",
		name: "GLM-4.1V-Thinking-Flash (free)",
		contextWindow: CTX_64K,
		maxTokens: OUT_16K,
		input: ["text", "image"],
		imageLimits: CN_IMAGE_LIMITS,
		// `always`, but not because the gateway rejects `disabled` — it answers
		// 200 either way (live 2026-10-09). This model emits its reasoning as a
		// `<think>` block inside `content` and never fills reasoning_content, so
		// "off" would change nothing and is hidden from pi's picker.
		thinking: { kind: "always" },
		cny: { input: 0, output: 0, cacheRead: 0 },
	},
	{
		id: "glm-4.1v-thinking-flashx",
		name: "GLM-4.1V-Thinking-FlashX",
		contextWindow: CTX_64K,
		maxTokens: OUT_16K,
		input: ["text", "image"],
		imageLimits: CN_IMAGE_LIMITS,
		// Same text-embedded thinking as the free sibling (probed live 2026-10-09).
		thinking: { kind: "always" },
		cny: { input: 2, output: 2, cacheRead: 0 },
	},
];

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
	CATALOG.map((entry) => [entry.id, entry]),
);

/** Every image-capable entry carries documented limits (see CN_IMAGE_LIMITS*). */
export const IMAGE_MODEL_IDS: readonly string[] = CATALOG.filter((e) => e.input.includes("image")).map((e) => e.id);
