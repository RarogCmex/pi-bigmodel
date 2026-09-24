import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import {
	buildModels,
	cnyPerUsd,
	cnyToUsd,
	DEFAULT_BASE_URL,
	entryToModel,
	PROVIDER_ID,
	unknownModelToModel,
} from "../models.ts";
import { CATALOG, CATALOG_BY_ID, type CatalogEntry } from "../catalog.ts";

const RATE = 7;

function compatOf(entry: CatalogEntry): OpenAICompletionsCompat & Record<string, unknown> {
	return entryToModel(entry, DEFAULT_BASE_URL, RATE).compat as never;
}

describe("buildModels / entryToModel", () => {
	test("provider, api and base url are pinned on every model", () => {
		for (const model of buildModels(DEFAULT_BASE_URL)) {
			assert.equal(model.provider, PROVIDER_ID);
			assert.equal(model.api, "openai-completions");
			assert.equal(model.baseUrl, DEFAULT_BASE_URL);
		}
		assert.equal(buildModels(DEFAULT_BASE_URL).length, CATALOG.length);
	});

	test("shared compat flags match the live-verified gateway behaviour", () => {
		for (const model of buildModels(DEFAULT_BASE_URL)) {
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
		const model = entryToModel(CATALOG_BY_ID.get("glm-4-flash-250414")!, DEFAULT_BASE_URL, RATE);
		assert.equal(model.reasoning, false);
		assert.equal(model.thinkingLevelMap, undefined);
	});

	test("dynamic: reasoning on, effort off, no level map", () => {
		const model = entryToModel(CATALOG_BY_ID.get("glm-4.6")!, DEFAULT_BASE_URL, RATE);
		assert.equal(model.reasoning, true);
		assert.equal((model.compat as Record<string, unknown>).supportsReasoningEffort, false);
		assert.equal(model.thinkingLevelMap, undefined);
	});

	test("effort (glm-5.2): full reasoning_effort scale", () => {
		const model = entryToModel(CATALOG_BY_ID.get("glm-5.2")!, DEFAULT_BASE_URL, RATE);
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
		for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-4.7", "glm-4.5v", "glm-4.1v-thinking-flash"]) {
			const model = entryToModel(CATALOG_BY_ID.get(id)!, DEFAULT_BASE_URL, RATE);
			assert.equal(model.reasoning, true, id);
			assert.equal(model.thinkingLevelMap?.off, null, id);
		}
		// GLM-5.3 effort is exactly low|high|max (server 400s otherwise).
		assert.deepEqual(entryToModel(CATALOG_BY_ID.get("glm-5.3")!, DEFAULT_BASE_URL, RATE).thinkingLevelMap, {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	test("cost is CNY-derived USD with cache tiers", () => {
		const model = entryToModel(CATALOG_BY_ID.get("glm-5.1")!, DEFAULT_BASE_URL, RATE);
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
		const model = entryToModel(CATALOG_BY_ID.get("glm-4.7-flash")!, DEFAULT_BASE_URL, RATE);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(model.cost.tiers, undefined);
	});

	test("vision models declare image input", () => {
		for (const id of ["glm-5.3-flash", "glm-4.6v", "glm-4.5v", "glm-5v-turbo"]) {
			const model = entryToModel(CATALOG_BY_ID.get(id)!, DEFAULT_BASE_URL, RATE);
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
		const model = unknownModelToModel("glm-6", DEFAULT_BASE_URL);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("family guesses", () => {
		const glm53 = unknownModelToModel("glm-5.3-turbo", DEFAULT_BASE_URL);
		assert.equal(glm53.thinkingLevelMap?.off, null);
		assert.equal((glm53.compat as Record<string, unknown>).supportsReasoningEffort, true);
		assert.equal(glm53.contextWindow, 1_048_576);

		const glm52 = unknownModelToModel("glm-5.2-turbo", DEFAULT_BASE_URL);
		assert.equal(glm52.thinkingLevelMap?.off, "none");

		const glm5 = unknownModelToModel("glm-5.4", DEFAULT_BASE_URL);
		assert.equal((glm5.compat as Record<string, unknown>).supportsReasoningEffort, false);
		assert.equal(glm5.contextWindow, 204_800);

		const vlm = unknownModelToModel("glm-6v", DEFAULT_BASE_URL);
		assert.deepEqual(vlm.input, ["text", "image"]);

		const stranger = unknownModelToModel("mystery-model", DEFAULT_BASE_URL);
		assert.equal(stranger.reasoning, false);
		assert.deepEqual(stranger.input, ["text"]);
	});
});
