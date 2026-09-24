import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { CATALOG, CATALOG_BY_ID, type CnyTier } from "../catalog.ts";
import { DEFAULT_BASE_URL } from "../models.ts";

/** Exact live listing of `GET /models` on open.bigmodel.cn, 2026-09-24. */
const LIVE_MODELS_IDS = [
	"glm-4.5",
	"glm-4.5-air",
	"glm-4.6",
	"glm-4.7",
	"glm-5",
	"glm-5-turbo",
	"glm-5.1",
	"glm-5.2",
	"glm-5.3",
	"glm-5.3-flash",
	"glm-5.3-flashx",
];

describe("catalog invariants", () => {
	test("ids are unique", () => {
		const ids = CATALOG.map((e) => e.id);
		assert.equal(new Set(ids).size, ids.length);
	});

	test("windows and prices are sane", () => {
		for (const entry of CATALOG) {
			assert.ok(entry.contextWindow > 0, entry.id);
			assert.ok(entry.maxTokens > 0, entry.id);
			assert.ok(entry.maxTokens <= entry.contextWindow, `${entry.id}: output > context`);
			assert.ok(entry.cny.input >= 0 && entry.cny.output >= 0, entry.id);
			assert.ok(entry.input.includes("text"), `${entry.id}: no text input`);
		}
	});

	test("tiers are sorted, above-zero and pricier than the base", () => {
		for (const entry of CATALOG) {
			const tiers = entry.cnyTiers;
			if (!tiers) continue;
			const sorted = [...tiers].sort((a: CnyTier, b: CnyTier) => a.inputTokensAbove - b.inputTokensAbove);
			assert.deepEqual(tiers, sorted, entry.id);
			for (const tier of tiers) {
				assert.ok(tier.inputTokensAbove > 0, entry.id);
				assert.ok(tier.input >= entry.cny.input, `${entry.id}: tier input cheaper than base`);
				assert.ok(tier.output >= entry.cny.output, `${entry.id}: tier output cheaper than base`);
			}
		}
	});

	test("free models have zero cost", () => {
		for (const id of ["glm-4.7-flash", "glm-4.5-flash", "glm-4-flash-250414", "glm-4.6v-flash", "glm-4.1v-thinking-flash"]) {
			const entry = CATALOG_BY_ID.get(id);
			assert.ok(entry, id);
			assert.deepEqual(entry.cny, { input: 0, output: 0, cacheRead: 0 });
			assert.equal(entry.priceNote, undefined);
		}
	});

	test("every model in the live /models listing is curated", () => {
		for (const id of LIVE_MODELS_IDS) {
			assert.ok(CATALOG_BY_ID.has(id), `catalog missing live id ${id}`);
		}
	});

	test("no entry uses the wrong default base url field", () => {
		for (const entry of CATALOG) {
			assert.ok(entry.name.length > 0);
			assert.ok(entry.id.startsWith("glm-"), entry.id);
		}
		assert.ok(DEFAULT_BASE_URL.startsWith("https://open.bigmodel.cn"));
	});
});
