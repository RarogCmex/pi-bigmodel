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
 *   5. GET /models matches the ids the catalog expects.
 *
 * Probed green against the live CN endpoint on 2026-09-24.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG } from "../catalog.ts";
import { DEFAULT_BASE_URL } from "../models.ts";
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
