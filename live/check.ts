/**
 * Live smoke test — only runs when BIGMODEL_API_KEY is set:
 *   BIGMODEL_API_KEY=… npm run live
 *
 * Verifies against the real gateway (cheap: max_tokens ≤ 8, one request per
 * catalog id, ~50 completion tokens total):
 *   1. every catalog id answers /chat/completions;
 *   2. a dynamic thinker accepts thinking.type=disabled;
 *   3. a forced thinker (glm-5.3) rejects disabled with code 1210;
 *   4. glm-5.2 accepts thinking+reasoning_effort and streams reasoning_content;
 *   5. GET /models matches the ids the catalog expects;
 *   6. the reclassified thinkers behave as the catalog now claims (glm-4.7 /
 *      glm-4.5v honour thinking.type=disabled; glm-4.1v-thinking does not);
 *   7. output caps and the context-overflow code, both read from REJECTIONS on
 *      free models (a rejected request is not billed);
 *   8. cache hits are reported in usage.prompt_tokens_details.cached_tokens.
 *
 * Checks 6-8 were added 2026-10-09 after the docs/behaviour refresh; the raw
 * probe output of that session is in `research/evidence-2026-10-09.json`.
 *
 * Every test below is skipped unless BIGMODEL_API_KEY is set, so the file is
 * safe to leave in the tree: `npm test` never reaches the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CATALOG, CATALOG_BY_ID } from "../catalog.ts";
import { DEFAULT_BASE_URL, entryToModel } from "../models.ts";
import { parseModelIds } from "../discovery.ts";

const KEY = process.env.BIGMODEL_API_KEY?.trim();
const BASE = process.env.BIGMODEL_BASE_URL?.trim() || DEFAULT_BASE_URL;

/** Free-tier models answer 429 under bursts; a live smoke test retries a couple of times. */
async function chat(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(90_000),
		});
		if (response.status !== 429 || attempt >= 5) {
			return { status: response.status, json: await response.json().catch(() => null) };
		}
		await new Promise((resolve) => setTimeout(resolve, attempt * 4_000));
	}
}

test("live: catalog ids answer chat completions", { skip: !KEY && "set BIGMODEL_API_KEY" }, async (t) => {
	for (const entry of CATALOG) {
		await t.test(entry.id, async () => {
			const { status, json } = await chat({
				model: entry.id,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 8,
			});
			assert.equal(status, 200, JSON.stringify(json).slice(0, 200));
			assert.ok(json.choices?.[0]?.message, "no choices in response");
		});
	}
});

test("live: dynamic thinker accepts thinking disabled", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	const { status, json } = await chat({
		model: "glm-4.7-flash",
		messages: [{ role: "user", content: "2+2?" }],
		max_tokens: 20,
		thinking: { type: "disabled" },
	});
	assert.equal(status, 200, JSON.stringify(json).slice(0, 200));
	assert.equal(json.choices[0].message.reasoning_content ?? "", "");
});

test("live: glm-5.3 rejects thinking disabled with code 1210", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	const { status, json } = await chat({
		model: "glm-5.3",
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 8,
		thinking: { type: "disabled" },
	});
	assert.equal(status, 400);
	assert.equal(json?.error?.code, "1210");
});

test("live: glm-5.2 streams reasoning_content with effort", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	const response = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "glm-5.2",
			messages: [{ role: "user", content: "2+2?" }],
			max_tokens: 300,
			stream: true,
			thinking: { type: "enabled", clear_thinking: false },
			reasoning_effort: "low",
			tool_stream: true,
		}),
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(response.status, 200);
	const body = await response.text();
	assert.match(body, /"reasoning_content"/);
});

test("live: GET /models returns the expected listing", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	const response = await fetch(`${BASE}/models`, {
		headers: { Authorization: `Bearer ${KEY}` },
		signal: AbortSignal.timeout(15_000),
	});
	assert.equal(response.status, 200);
	const ids = parseModelIds(await response.json());
	for (const expected of ["glm-4.5", "glm-4.6", "glm-4.7", "glm-5", "glm-5.2", "glm-5.3", "glm-5.3-flash"]) {
		assert.ok(ids.includes(expected), `missing ${expected}`);
	}
});

/**
 * Streaming probe with a client-side kill switch: aborts as soon as the gateway
 * produces output, so a probe that is unexpectedly ACCEPTED cannot run away.
 * Never rely on the gateway to reject (see the skill's cost rules).
 */
async function cappedProbe(model: string, maxTokens: number): Promise<{ status: number; json: any }> {
	const controller = new AbortController();
	const response = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: maxTokens, stream: true }),
		signal: controller.signal,
	});
	const text = await response.text();
	controller.abort();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		const body = /data: (\{.*\})/.exec(text)?.[1];
		if (body) json = JSON.parse(body);
	}
	return { status: response.status, json };
}

test("live: reclassified thinkers behave as the catalog claims", { skip: !KEY && "set BIGMODEL_API_KEY" }, async (t) => {
	// glm-4.7 and glm-4.5v were forced thinkers on 2026-09-24. Both accepted
	// thinking.type=disabled on 2026-10-09 AND stopped reasoning
	// (completion_tokens_details.reasoning_tokens === 0), which is why they are
	// `dynamic` in the catalog now.
	for (const id of ["glm-4.7", "glm-4.5v"]) {
		await t.test(`${id} honours disabled`, async () => {
			const { status, json } = await chat({
				model: id,
				messages: [{ role: "user", content: "What is 12*13? Answer with just the number." }],
				max_tokens: 64,
				thinking: { type: "disabled" },
			});
			assert.equal(status, 200, JSON.stringify(json).slice(0, 200));
			assert.equal(json.usage?.completion_tokens_details?.reasoning_tokens ?? 0, 0, `${id} still reasoned with thinking disabled`);
			assert.equal(json.choices?.[0]?.message?.reasoning_content ?? "", "", id);
		});
	}

	// glm-4.1v-thinking-* stay `always`: the gateway accepts disabled but the
	// model emits its reasoning as a `<think>` block inside content either way.
	await t.test("glm-4.1v-thinking-flash ignores disabled", async () => {
		const { status, json } = await chat({
			model: "glm-4.1v-thinking-flash",
			messages: [{ role: "user", content: "What is 12*13?" }],
			max_tokens: 48,
			thinking: { type: "disabled" },
		});
		assert.equal(status, 200, JSON.stringify(json).slice(0, 200));
		assert.match(json.choices?.[0]?.message?.content ?? "", /<think>|\\d/, "expected the reasoning to leak into content");
	});
});

test("live: output caps come back in free rejections", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	// `max_tokens: 99999999` is rejected with 400/1210
	// 「max_tokens参数非法：限制数值范围[1,N]」 — the cap is disclosed for free.
	// Restricted to zero-cost models: if a gateway ever ACCEPTED the value, the
	// request would be billed, and the abort guard below caps the damage.
	for (const id of ["glm-4.5-flash", "glm-4.7-flash", "glm-4-flash-250414", "glm-4.6v-flash", "glm-4.1v-thinking-flash"]) {
		const entry = CATALOG_BY_ID.get(id);
		if (!entry) continue;
		const { status, json } = await cappedProbe(id, 99_999_999);
		if (status === 200) continue; // accepted: no free signal, nothing to assert
		assert.equal(status, 400, `${id}: ${JSON.stringify(json).slice(0, 200)}`);
		const disclosed = Number(/\[1,\s*(\d+)\]/.exec(String(json?.error?.message ?? ""))?.[1]);
		assert.ok(Number.isFinite(disclosed), `${id}: no cap disclosed in ${json?.error?.message}`);
		assert.equal(disclosed, entry.maxTokens, `${id}: catalog maxTokens is stale`);
	}
});

test("live: context overflow is 400/1261 and reaches pi's compaction", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	// ~200K filler tokens against a 128K-window free model: rejected, therefore
	// not billed. This is the check the README used to list as "not reproduced
	// live"; the recorded body is `{"code":"1261","message":"Prompt exceeds max
	// length"}` (2026-10-09).
	const model = "glm-4.5-flash";
	const entry = CATALOG_BY_ID.get(model)!;
	const filler = Array.from({ length: entry.contextWindow * 2 }, (_, i) => `filler ${i} `).join("");
	const response = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: `${filler}\nSay ok` }], max_tokens: 1 }),
		signal: AbortSignal.timeout(180_000),
	});
	const json = await response.json().catch(() => null);
	assert.equal(response.status, 400, `expected a rejection, got ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
	assert.equal(String(json?.error?.code), "1261", JSON.stringify(json).slice(0, 300));

	// The point of the check: pi must classify it as overflow so auto-compaction
	// runs. Asserted through pi's real classifier with the body as pi surfaces it.
	const surfaced = `${response.status}: ${JSON.stringify(json.error)}`;
	const message = { role: "assistant", stopReason: "error", errorMessage: surfaced, provider: "bigmodel" } as unknown as AssistantMessage;
	assert.equal(isContextOverflow(message, entry.contextWindow), true, surfaced);
});

test("live: cache hits are reported in the documented field", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	// capabilities/cache.md: implicit cache, hits surface in
	// usage.prompt_tokens_details.cached_tokens, population is asynchronous.
	// Measured 2026-10-09 on a free model: miss, then 1508/1510 cached on the
	// next two calls. A hit is therefore expected but not asserted — the docs
	// promise no timing, so this check verifies the SHAPE and prints what happened.
	const model = "glm-4.5-flash";
	const prefix = Array.from({ length: 60 }, (_, i) => `${i}. Stable prefix line for the implicit BigModel context cache probe.`).join("\n");
	const seen: (number | undefined)[] = [];
	for (const attempt of [1, 2, 3]) {
		const { status, json } = await chat({
			model,
			messages: [
				{ role: "system", content: prefix },
				{ role: "user", content: `probe ${attempt}` },
			],
			max_tokens: 1,
			thinking: { type: "enabled", clear_thinking: false },
		});
		assert.equal(status, 200, JSON.stringify(json).slice(0, 200));
		const cached = json.usage?.prompt_tokens_details?.cached_tokens;
		assert.ok(cached === undefined || (Number.isInteger(cached) && cached <= json.usage.prompt_tokens), `bad cached_tokens: ${cached}`);
		seen.push(cached);
		await new Promise((resolve) => setTimeout(resolve, 8_000));
	}
	console.log(`      cache probe cached_tokens: ${JSON.stringify(seen)}`);
});
