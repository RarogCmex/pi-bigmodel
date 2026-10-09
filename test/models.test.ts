import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { calculateCost, clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import {
	buildModels,
	cnyPerUsd,
	cnyToUsd,
	DEFAULT_BASE_URL,
	entryToModel,
	PROVIDER_ID,
	unknownModelToModel,
	RESPONSES_BASE_URL,
} from "../models.ts";
import { CATALOG, CATALOG_BY_ID, type CatalogEntry } from "../catalog.ts";

const CHAT = "openai-completions" as const;
const RESP = "openai-responses" as const;

const RATE = 7;

function compatOf(entry: CatalogEntry): OpenAICompletionsCompat & Record<string, unknown> {
	return entryToModel(entry, DEFAULT_BASE_URL, RATE, CHAT).compat as never;
}

describe("buildModels / entryToModel", () => {
	test("provider, api and base url are pinned on every model", () => {
		for (const model of buildModels(CHAT, DEFAULT_BASE_URL)) {
			assert.equal(model.provider, PROVIDER_ID);
			assert.equal(model.api, "openai-completions");
			assert.equal(model.baseUrl, DEFAULT_BASE_URL);
		}
		assert.equal(buildModels(CHAT, DEFAULT_BASE_URL).length, CATALOG.length);
	});

	test("shared compat flags match the live-verified gateway behaviour", () => {
		for (const model of buildModels(CHAT, DEFAULT_BASE_URL)) {
			const c = model.compat as Record<string, unknown>;
			assert.equal(c.thinkingFormat, "zai");
			assert.equal(c.maxTokensField, "max_tokens");
			assert.equal(c.supportsDeveloperRole, false);
			assert.equal(c.supportsStore, false);
			assert.equal(c.supportsLongCacheRetention, false);
			assert.equal(c.zaiToolStream, true);
		}
	});

	test("none: not a reasoning model, no effort", () => {
		const c = compatOf(CATALOG_BY_ID.get("glm-4-flash-250414")!);
		assert.equal(CATALOG_BY_ID.get("glm-4-flash-250414")!.thinking.kind, "none");
		assert.equal(c.supportsReasoningEffort, false);
		const model = entryToModel(CATALOG_BY_ID.get("glm-4-flash-250414")!, DEFAULT_BASE_URL, RATE, CHAT);
		assert.equal(model.reasoning, false);
		assert.equal(model.thinkingLevelMap, undefined);
	});

	test("dynamic: reasoning on, effort off, no level map", () => {
		const model = entryToModel(CATALOG_BY_ID.get("glm-4.6")!, DEFAULT_BASE_URL, RATE, CHAT);
		assert.equal(model.reasoning, true);
		assert.equal((model.compat as Record<string, unknown>).supportsReasoningEffort, false);
		assert.equal(model.thinkingLevelMap, undefined);
	});

	test("effort (glm-5.2): full reasoning_effort scale", () => {
		const model = entryToModel(CATALOG_BY_ID.get("glm-5.2")!, DEFAULT_BASE_URL, RATE, CHAT);
		assert.equal(model.reasoning, true);
		assert.equal((model.compat as Record<string, unknown>).supportsReasoningEffort, true);
		assert.deepEqual(model.thinkingLevelMap, {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	test("forced thinkers hide 'off' so pi never sends thinking.type=disabled", () => {
		for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-4.1v-thinking-flash"]) {
			const model = entryToModel(CATALOG_BY_ID.get(id)!, DEFAULT_BASE_URL, RATE, CHAT);
			assert.equal(model.reasoning, true, id);
			assert.equal(model.thinkingLevelMap?.off, null, id);
			// Assert through pi's own picker logic, not just the raw map: this is
			// what decides whether "off" is offered to the user.
			assert.ok(!getSupportedThinkingLevels(model).includes("off"), `${id}: pi still offers off`);
		}
		// GLM-5.3 effort is exactly low|high|max (server 400s otherwise: probed
		// 2026-10-09, `reasoning_effort: "medium"` → 400 code 1210).
		assert.deepEqual(entryToModel(CATALOG_BY_ID.get("glm-5.3")!, DEFAULT_BASE_URL, RATE, CHAT).thinkingLevelMap, {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	test("GLM-4.7 / GLM-4.5V offer 'off' again (turn-level thinking, probed 2026-10-09)", () => {
		// Both were forced thinkers on 2026-09-24. `thinking:{type:"disabled"}` is
		// now accepted AND honoured: a 64-token answer to "12*13" came back as
		// content "156" with completion_tokens_details.reasoning_tokens === 0,
		// while `enabled` spent all 64 tokens in reasoning_content.
		for (const id of ["glm-4.7", "glm-4.5v"]) {
			const model = entryToModel(CATALOG_BY_ID.get(id)!, DEFAULT_BASE_URL, RATE, CHAT);
			assert.equal(model.reasoning, true, id);
			assert.equal(model.thinkingLevelMap, undefined, `${id}: should not pin a level map`);
			assert.equal((model.compat as Record<string, unknown>).supportsReasoningEffort, false, id);
			assert.ok(getSupportedThinkingLevels(model).includes("off"), `${id}: pi must offer off`);
			assert.equal(clampThinkingLevel(model, "off"), "off", id);
		}
	});

	test("image models publish the documented CN input limits", () => {
		const imageModels = buildModels(CHAT, DEFAULT_BASE_URL).filter((m) => m.input.includes("image"));
		assert.ok(imageModels.length >= 8, `expected the VLM families, got ${imageModels.length}`);
		for (const model of imageModels) {
			const resize = model.inputLimits?.images?.resize;
			assert.ok(resize, `${model.id}: no inputLimits.images.resize`);
			// openapi.json → VisionMultimodalContentItem (2026-10-09): every image
			// ≤5 MB and ≤6000×6000 px. pi's maxBytes is the BASE64 payload size, so
			// 5e6 keeps the decoded file under the documented cap either way.
			assert.equal(resize!.maxWidth, 6000, model.id);
			assert.equal(resize!.maxHeight, 6000, model.id);
			assert.equal(resize!.maxBytes, 5_000_000, model.id);
		}
		// The 50-images-per-request cap is documented only for the 5.3-Flash /
		// 5V-Turbo / 4.6V / 4.5V families, so the 4.1V entries must not claim it.
		for (const model of buildModels(CHAT, DEFAULT_BASE_URL)) {
			if (!model.input.includes("image")) {
				assert.equal(model.inputLimits, undefined, `${model.id}: text model must not carry image limits`);
			}
		}
		const byId = new Map(buildModels(CHAT, DEFAULT_BASE_URL).map((m) => [m.id, m]));
		assert.equal(byId.get("glm-4.6v")!.inputLimits?.images?.maxPerRequest, 50);
		assert.equal(byId.get("glm-4.1v-thinking-flash")!.inputLimits?.images?.maxPerRequest, undefined);
	});

	test("a guessed vision id inherits the endpoint-wide image caps", () => {
		const model = unknownModelToModel("glm-6.9v-turbo", DEFAULT_BASE_URL, CHAT);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.inputLimits?.images?.resize?.maxWidth, 6000);
		assert.equal(unknownModelToModel("glm-6.9", DEFAULT_BASE_URL, CHAT).inputLimits, undefined);
	});

	test("cost is CNY-derived USD with cache tiers", () => {
		const model = entryToModel(CATALOG_BY_ID.get("glm-5.1")!, DEFAULT_BASE_URL, RATE, CHAT);
		assert.equal(model.cost.input, cnyToUsd(6, RATE));
		assert.equal(model.cost.output, cnyToUsd(24, RATE));
		assert.equal(model.cost.cacheRead, cnyToUsd(1.3, RATE));
		assert.equal(model.cost.cacheWrite, 0);
		assert.deepEqual(
			model.cost.tiers?.map((t) => ({ above: t.inputTokensAbove, input: t.input })),
			[{ above: 32_768, input: cnyToUsd(8, RATE) }],
		);
	});

	test("free models convert to zero cost", () => {
		const model = entryToModel(CATALOG_BY_ID.get("glm-4.7-flash")!, DEFAULT_BASE_URL, RATE, CHAT);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(model.cost.tiers, undefined);
	});

	test("vision models declare image input", () => {
		for (const id of ["glm-5.3-flash", "glm-4.6v", "glm-4.5v", "glm-5v-turbo"]) {
			const model = entryToModel(CATALOG_BY_ID.get(id)!, DEFAULT_BASE_URL, RATE, CHAT);
			assert.deepEqual(model.input, ["text", "image"], id);
		}
	});
});

describe("cnyPerUsd", () => {
	test("env override wins", () => {
		assert.equal(cnyPerUsd(() => "7.5"), 7.5);
		assert.equal(cnyPerUsd(() => "not-a-number") > 0, true);
		assert.equal(cnyPerUsd(() => undefined) > 0, true);
	});
});

describe("unknownModelToModel", () => {
	test("zero cost, never an invented price", () => {
		const model = unknownModelToModel("glm-6", DEFAULT_BASE_URL, CHAT);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("family guesses", () => {
		const glm53 = unknownModelToModel("glm-5.3-turbo", DEFAULT_BASE_URL, CHAT);
		assert.equal(glm53.thinkingLevelMap?.off, null);
		assert.equal((glm53.compat as Record<string, unknown>).supportsReasoningEffort, true);
		assert.equal(glm53.contextWindow, 1_048_576);

		const glm52 = unknownModelToModel("glm-5.2-turbo", DEFAULT_BASE_URL, CHAT);
		assert.equal(glm52.thinkingLevelMap?.off, "none");

		const glm5 = unknownModelToModel("glm-5.4", DEFAULT_BASE_URL, CHAT);
		assert.equal((glm5.compat as Record<string, unknown>).supportsReasoningEffort, false);
		assert.equal(glm5.contextWindow, 204_800);

		const vlm = unknownModelToModel("glm-6v", DEFAULT_BASE_URL, CHAT);
		assert.deepEqual(vlm.input, ["text", "image"]);

		const stranger = unknownModelToModel("mystery-model", DEFAULT_BASE_URL, CHAT);
		assert.equal(stranger.reasoning, false);
		assert.deepEqual(stranger.input, ["text"]);
	});
});

describe("prompt-cache metadata and cost math", () => {
	test("no model declares promptCache, so pi never sends cache-warming requests", () => {
		// BigModel's cache is implicit and the docs publish no TTL
		// (capabilities/cache.md, read 2026-10-09). pi's warmer needs a TTL:
		// `getPromptCacheTtlMs` returns undefined without `promptCache` and the
		// warmer stops with "cache lifetime unavailable"
		// (pi/dist/core/cache-warmer.js). Declaring a guessed TTL would make pi
		// replay billed requests to keep alive a cache it cannot schedule.
		// Both builds: the guard is about the catalog, and a future per-surface
		// field must not sneak a TTL in on only one of them.
		for (const api of [CHAT, RESP] as const) {
			const baseUrl = api === CHAT ? DEFAULT_BASE_URL : RESPONSES_BASE_URL;
			for (const model of buildModels(api, baseUrl)) {
				assert.equal(model.promptCache, undefined, `${api}/${model.id}`);
				assert.equal(model.cost.cacheWrite, 0, `${api}/${model.id}: storage is 限时免费`);
			}
		}
	});

	test("cache reads are priced, cache writes are not (storage is 限时免费)", () => {
		for (const entry of CATALOG) {
			const model = entryToModel(entry, DEFAULT_BASE_URL, RATE, CHAT);
			assert.equal(model.cost.cacheWrite, 0, entry.id);
			assert.equal(model.cost.cacheRead, cnyToUsd(entry.cny.cacheRead, RATE), entry.id);
		}
	});

	test("pi picks the pricing tier from prompt tokens INCLUDING cache hits", () => {
		// calculateCost (pi-ai/dist/models.js) matches tiers on
		// input + cacheRead + cacheWrite, which is exactly BigModel's
		// 「输入长度 ≥32K」 band: the band is about prompt length, not about the
		// part of it that was billed fresh. A 40K prompt that is 90% cached must
		// still be priced in the ≥32K band.
		const model = entryToModel(CATALOG_BY_ID.get("glm-5.1")!, DEFAULT_BASE_URL, RATE, CHAT);
		assert.ok(model.cost.tiers?.length, "glm-5.1 must carry the ≥32K tier");
		const usage = {
			input: 4_000,
			output: 100,
			cacheRead: 36_000,
			cacheWrite: 0,
			totalTokens: 40_100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(model, usage);
		const tier = model.cost.tiers![0];
		assert.equal(usage.cost.input, (tier.input / 1e6) * usage.input, "tier input rate must apply");
		assert.equal(usage.cost.cacheRead, (tier.cacheRead / 1e6) * usage.cacheRead, "tier cacheRead rate must apply");
		assert.notEqual(tier.input, model.cost.input, "precondition: the tier differs from the base rate");

		// Below the threshold the base band applies.
		const small = { ...usage, input: 4_000, cacheRead: 6_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		calculateCost(model, small);
		assert.equal(small.cost.input, (model.cost.input / 1e6) * small.input);
	});
});
