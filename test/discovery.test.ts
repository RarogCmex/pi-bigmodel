import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { buildOverlay, fetchBigModelModels, parseModelIds } from "../discovery.ts";

const CHAT = "openai-completions" as const;
import { DEFAULT_BASE_URL } from "../models.ts";
import { CATALOG_BY_ID } from "../catalog.ts";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";

/** Exact shape of the live `GET /models` response, 2026-09-24. */
const LIVE_PAYLOAD = {
	object: "list",
	data: [
		{ id: "glm-4.5", object: "model", created: 1753632000, owned_by: "z-ai" },
		{ id: "glm-4.5-air", object: "model", created: 1753632000, owned_by: "z-ai" },
		{ id: "glm-4.6", object: "model", created: 1759276800, owned_by: "z-ai" },
		{ id: "glm-4.7", object: "model", created: 1766332800, owned_by: "z-ai" },
		{ id: "glm-5", object: "model", created: 1770739200, owned_by: "z-ai" },
		{ id: "glm-5-turbo", object: "model", created: 1773504000, owned_by: "z-ai" },
		{ id: "glm-5.1", object: "model", created: 1774620000, owned_by: "z-ai" },
		{ id: "glm-5.2", object: "model", created: 1781625600, owned_by: "z-ai" },
		{ id: "glm-5.3", object: "model", created: 1786636800, owned_by: "z-ai" },
		{ id: "glm-5.3-flash", object: "model", created: 1786636800, owned_by: "z-ai" },
		{ id: "glm-5.3-flashx", object: "model", created: 1786636800, owned_by: "z-ai" },
	],
};

function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		allowNetwork: true,
		signal: new AbortController().signal,
		credential: { type: "api_key", key: "test-key" },
		...overrides,
	} as RefreshModelsContext;
}

describe("parseModelIds", () => {
	test("parses the live payload shape, deduplicates and trims", () => {
		const ids = parseModelIds({ data: [{ id: " glm-9 " }, { id: "glm-9" }, { id: "" }, { id: 42 }, {}] });
		assert.deepEqual(ids, ["glm-9"]);
	});

	test("parses the actual live listing", () => {
		const ids = parseModelIds(LIVE_PAYLOAD);
		assert.equal(ids.length, 11);
		assert.ok(ids.includes("glm-5.3-flashx"));
	});

	test("non-chat modalities are excluded", () => {
		const ids = parseModelIds({
			data: [{ id: "embedding-3" }, { id: "cogview-4" }, { id: "glm-ocr" }, { id: "autoglm-phone" }, { id: "glm-6" }],
		});
		assert.deepEqual(ids, ["glm-6"]);
	});

	test("garbage in, empty out", () => {
		assert.deepEqual(parseModelIds(null), []);
		assert.deepEqual(parseModelIds({}), []);
		assert.deepEqual(parseModelIds({ data: "nope" }), []);
	});
});

describe("buildOverlay", () => {
	test("known ids produce no overlay — curated prices win", () => {
		const overlay = buildOverlay(parseModelIds(LIVE_PAYLOAD), DEFAULT_BASE_URL, CHAT);
		// Every live id is already curated, so the overlay is empty…
		assert.deepEqual(overlay.map((m) => m.id), []);
		// …but a brand-new id would register with family-guessed defaults.
		const fresh = buildOverlay(["glm-6"], DEFAULT_BASE_URL, CHAT);
		assert.deepEqual(fresh.map((m) => m.id), ["glm-6"]);
		assert.deepEqual(fresh[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("excluded families never auto-register", () => {
		assert.deepEqual(buildOverlay(["cogview-4", "embedding-3", "glm-5.4"], DEFAULT_BASE_URL, CHAT).map((m) => m.id), [
			"glm-5.4",
		]);
	});

	test("an explicit known-set is honoured", () => {
		const overlay = buildOverlay(["glm-5.3"], DEFAULT_BASE_URL, CHAT, new Set(CATALOG_BY_ID.keys()));
		assert.deepEqual(overlay, []);
	});
});

describe("fetchBigModelModels", () => {
	const originalFetch = globalThis.fetch;

	function withFetch(impl: typeof fetch | undefined, fn: () => Promise<void>): Promise<void> {
		(globalThis as { fetch?: typeof fetch }).fetch = impl;
		return fn().finally(() => {
			(globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
		});
	}

	test("no network / no key / aborted → empty overlay, no fetch", async () => {
		let called = 0;
		await withFetch(() => { called++; throw new Error("must not fetch"); }, async () => {
			assert.deepEqual(await fetchBigModelModels({ listingBaseUrl: DEFAULT_BASE_URL, baseUrl: DEFAULT_BASE_URL, api: CHAT }, context({ allowNetwork: false })), []);
			const aborted = new AbortController();
			aborted.abort();
			assert.deepEqual(await fetchBigModelModels({ listingBaseUrl: DEFAULT_BASE_URL, baseUrl: DEFAULT_BASE_URL, api: CHAT }, context({ signal: aborted.signal })), []);
			assert.deepEqual(
				await fetchBigModelModels({ listingBaseUrl: DEFAULT_BASE_URL, baseUrl: DEFAULT_BASE_URL, api: CHAT }, context({ credential: undefined })),
				[],
			);
		});
		assert.equal(called, 0);
	});

	test("env key is used when the auth layer has none", async () => {
		const originalEnv = process.env.BIGMODEL_API_KEY;
		process.env.BIGMODEL_API_KEY = "env-key";
		let seenAuth = "";
		await withFetch(
			(async (_input: unknown, init?: RequestInit) => {
				seenAuth = String(init?.headers instanceof Headers ? init.headers.get("Authorization") : (init?.headers as Record<string, string>)?.Authorization ?? "");
				return new Response(JSON.stringify({ data: [{ id: "glm-6" }] }), { status: 200 });
			}) as unknown as typeof fetch,
			async () => {
				const out = await fetchBigModelModels({ listingBaseUrl: DEFAULT_BASE_URL, baseUrl: DEFAULT_BASE_URL, api: CHAT }, context({ credential: undefined }));
				assert.deepEqual(out.map((m) => m.id), ["glm-6"]);
			},
		);
		assert.ok(seenAuth.includes("Bearer"), "expected a bearer header");
		process.env.BIGMODEL_API_KEY = originalEnv;
	});

	test("non-ok and network failure degrade to an empty overlay", async () => {
		await withFetch((async () => new Response("nope", { status: 401 })) as unknown as typeof fetch, async () => {
			assert.deepEqual(await fetchBigModelModels({ listingBaseUrl: DEFAULT_BASE_URL, baseUrl: DEFAULT_BASE_URL, api: CHAT }, context()), []);
		});
		await withFetch((async () => { throw new Error("network down"); }) as unknown as typeof fetch, async () => {
			assert.deepEqual(await fetchBigModelModels({ listingBaseUrl: DEFAULT_BASE_URL, baseUrl: DEFAULT_BASE_URL, api: CHAT }, context()), []);
		});
	});
});
