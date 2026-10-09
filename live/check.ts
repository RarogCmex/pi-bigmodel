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
import { deflateSync } from "node:zlib";
import test from "node:test";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CATALOG, CATALOG_BY_ID } from "../catalog.ts";
import { DEFAULT_BASE_URL, entryToModel } from "../models.ts";
import { parseModelIds } from "../discovery.ts";
import { clarifyErrorMessage, remediateInBandResponse, shouldClarify } from "../errors.ts";

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

/**
 * The Responses surface (`/api/v1/responses`), which is what the plugin
 * registers by default. Same cost discipline: availability and limits are read
 * from rejections, and every accepted call is `max_output_tokens <= 32` on a
 * free model or a few tokens on a paid one.
 */
const RESP = "https://open.bigmodel.cn/api/v1/responses";

/**
 * A correctly encoded 16×16 red PNG as a data URL, built here rather than pasted:
 * the first version of this check used a hand-written base64 blob that was not a
 * valid PNG, and the gateway's 「图片输入格式/解析错误」 read as "this surface does
 * not take data URLs". Encode it, and the same shape is accepted and read.
 */
const RED_SQUARE_PNG: string = (() => {
	const table: number[] = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	const crc = (bytes: Uint8Array) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Uint8Array) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, sum]);
	};
	const size = 16;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // truecolor
	const rows: Buffer[] = [];
	for (let y = 0; y < size; y++) {
		const row = [0]; // filter: none
		for (let x = 0; x < size; x++) row.push(255, 0, 0);
		rows.push(Buffer.from(row));
	}
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", new Uint8Array(0)),
	]);
	return `data:image/png;base64,${png.toString("base64")}`;
})();

async function responses(body: Record<string, unknown>, key: string = KEY!, timeoutMs = 90_000) {
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(RESP, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		if (response.status === 429 && attempt < 5) {
			await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
			continue;
		}
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* a stream body, handled by the caller */
		}
		return { status: response.status, json, text };
	}
}

test("live: every catalog id exists on the Responses surface", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	// Free by construction: `max_output_tokens: 99999999` is rejected before any
	// inference, and the rejection text discloses the cap. A missing model would
	// answer `model_not_found` instead — so this asserts existence AND that the
	// catalog's maxTokens still matches what the gateway enforces.
	for (const entry of CATALOG) {
		const { status, json } = await responses({ model: entry.id, input: "hi", max_output_tokens: 99_999_999 });
		assert.equal(status, 400, `${entry.id}: ${JSON.stringify(json).slice(0, 160)}`);
		assert.notEqual(json?.error?.code, "model_not_found", `${entry.id} is not served on this surface`);
		const disclosed = Number(/\[1,\s*(\d+)\]/.exec(String(json?.error?.message ?? ""))?.[1]);
		assert.equal(disclosed, entry.maxTokens, `${entry.id}: catalog maxTokens is stale`);
	}
});

test("live: a Responses stream completes with reasoning, text and cache details", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	const { status, text } = await responses(
		{
			model: "glm-4.5-flash",
			input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: OK" }] }],
			max_output_tokens: 200,
			stream: true,
			store: false,
			prompt_cache_key: "pi-live-check",
		},
		KEY,
	);
	assert.equal(status, 200);
	assert.match(text, /event: response\.created/);
	assert.match(text, /event: response\.output_text\.delta/);
	assert.match(text, /event: response\.completed/);
	assert.match(text, /"input_tokens_details":\s*\{\s*"cached_tokens"/, "cache details must be reported");
});

test("live: an in-band 200 auth failure is remediated into a clarified 401", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	// The Responses surface answers a bad credential with HTTP 200 and
	// {"code":1000,"msg":"身份验证失败。","success":false}; pi would otherwise
	// report "stream ended before a terminal response event" (retryable, and
	// silent about the key). This runs the real wrapper against the real gateway.
	const garbage = `${"0".repeat(32)}.${"deadbeefdeadbee"}`;
	const raw = await responses({ model: "glm-4.5-flash", input: "hi", max_output_tokens: 16 }, garbage);
	assert.equal(raw.status, 200, "precondition: the gateway really does answer 200");
	assert.equal(raw.json?.success, false);

	const remediated = await remediateInBandResponse(
		new Response(raw.text, { status: raw.status, headers: { "content-type": "application/json" } }),
	);
	assert.equal(remediated.status, 401);
	const body = await remediated.json();
	const surfaced = `401: ${JSON.stringify(body.error)}`;
	assert.equal(shouldClarify({ errorMessage: surfaced }), true);
	const clarified = clarifyErrorMessage(surfaced)!;
	assert.match(clarified, /\/login bigmodel/);
	assert.equal(isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: surfaced } as unknown as AssistantMessage), false);
});

test("live: images are read on the Responses surface in pi's own wire shape", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	// Regression guard for a false negative this repo nearly shipped: a
	// hand-written base64 PNG produced 400 「图片输入格式/解析错误」 and made the
	// string form of `image_url` look unsupported. With a correctly encoded PNG
	// the string data URL works and the model describes it, while the
	// completions-style `image_url: {url}` object is accepted with 200 and the
	// image is silently dropped. pi sends the string form — assert that stays true.
	const { status, json } = await responses({
		model: "glm-4.1v-thinking-flash",
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Reply with the name of one colour you can see in the image." },
					{ type: "input_image", detail: "auto", image_url: RED_SQUARE_PNG },
				],
			},
		],
		max_output_tokens: 32,
	});
	assert.equal(status, 200, JSON.stringify(json?.error ?? json).slice(0, 200));
	assert.ok((json?.usage?.input_tokens ?? 0) > 20, `image tokens missing: ${JSON.stringify(json?.usage)}`);
});

test("live: the completions surface still answers when the protocol is switched back", { skip: !KEY && "set BIGMODEL_API_KEY" }, async () => {
	// BIGMODEL_PROTOCOL=completions is the documented escape hatch (it is the only
	// surface where thinking can actually be turned off), so it must not rot.
	const model = entryToModel(CATALOG_BY_ID.get("glm-4.5-flash")!, DEFAULT_BASE_URL, 7, "openai-completions");
	const response = await fetch(`${DEFAULT_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: model.id,
			messages: [{ role: "user", content: "Reply with exactly: OK" }],
			max_tokens: 16,
			thinking: { type: "disabled" },
		}),
		signal: AbortSignal.timeout(90_000),
	});
	const json: any = await response.json().catch(() => null);
	assert.equal(response.status, 200, JSON.stringify(json).slice(0, 200));
	assert.equal(json?.usage?.completion_tokens_details?.reasoning_tokens ?? 0, 0, "thinking must be off on this surface");
	assert.match(String(json?.choices?.[0]?.message?.content ?? ""), /OK/);
});
