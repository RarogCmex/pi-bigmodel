/**
 * The Responses surface (`https://open.bigmodel.cn/api/v1/responses`).
 *
 * Everything here is offline: outgoing bytes are captured from pi-ai's real
 * `openai-responses` adapter with a stub `fetch`, and the incoming direction is
 * replayed from `test/fixtures/responses-stream-full.sse` — a byte-for-byte
 * capture of a live `glm-4.5-flash` stream (2026-10-09, 34 events: reasoning
 * item, message item, `response.completed` with `cached_tokens`). The raw probe
 * log behind every claim here is `research/evidence-2026-10-09-responses.json`.
 *
 * The point of this file is the three things that differ from completions and
 * would otherwise only show up against a paid API:
 *   1. "off" is not offered — the surface has no working thinking switch;
 *   2. `prompt_cache_key` goes out on every request (the documented cache-routing
 *      knob, and the reason this surface is the default);
 *   3. the field set is the OpenAI Responses one (`input`, `max_output_tokens`,
 *      `reasoning.effort`, output items), not the chat-completions one.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { openAIResponsesApi } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, normalizeContext, Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, ModelThinkingLevel, ThinkingLevel, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { CATALOG, CATALOG_BY_ID, GLM53_EFFORT } from "../catalog.ts";
import {
	BASE_URL_BY_API,
	DEFAULT_PROTOCOL,
	entryToModel,
	DEFAULT_CNY_PER_USD,
	resolveProtocol,
	RESPONSES_BASE_URL,
	RESPONSES_EFFORT,
} from "../models.ts";

const RESP = "openai-responses" as const;
const api = openAIResponsesApi();
const FIXTURE = readFileSync(new URL("./fixtures/responses-stream-full.sse", import.meta.url), "utf8");

function model(id: string): Model<"openai-responses"> {
	const entry = CATALOG_BY_ID.get(id);
	assert.ok(entry, `${id} missing from catalog`);
	return entryToModel(entry, RESPONSES_BASE_URL, DEFAULT_CNY_PER_USD, RESP) as Model<"openai-responses">;
}

function context(overrides: Partial<Context> = {}): TranscriptContext {
	return normalizeContext({
		systemPrompt: "You are pi, a coding agent.",
		messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
		...overrides,
	});
}

async function capture(
	target: Model<"openai-responses">,
	options: { reasoning?: ThinkingLevel; maxTokens?: number; tools?: Tool[]; messages?: Context["messages"]; sessionId?: string } = {},
): Promise<Record<string, any>> {
	let payload: Record<string, any> | undefined;
	const ctx = context({
		...(options.messages ? { messages: options.messages } : {}),
		...(options.tools ? { tools: options.tools } : {}),
	});
	const stream = api.streamSimple(target, ctx, {
		apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb",
		reasoning: options.reasoning,
		maxTokens: options.maxTokens ?? 512,
		sessionId: options.sessionId ?? "pi-session-42",
		onPayload: (body) => {
			payload = body as Record<string, any>;
			return undefined;
		},
		fetch: (() => {
			throw new Error("network blocked by responses test");
		}) as unknown as typeof fetch,
	});
	for await (const event of stream) if (event.type === "error" || event.type === "done") break;
	assert.ok(payload, "adapter never built a request payload");
	return JSON.parse(JSON.stringify(payload));
}

describe("protocol selection", () => {
	test("Responses is the default", () => {
		assert.equal(DEFAULT_PROTOCOL, "openai-responses");
		assert.equal(resolveProtocol(() => undefined).api, "openai-responses");
	});

	test("the env var accepts short and long names, any case, with padding", () => {
		for (const value of ["completions", "chat", "openai-completions", "  COMPLETIONS "]) {
			assert.equal(resolveProtocol(() => value).api, "openai-completions", value);
		}
		for (const value of ["responses", "openai-responses", " Responses "]) {
			assert.equal(resolveProtocol(() => value).api, "openai-responses", value);
		}
	});

	test("an unrecognized value falls back instead of failing at startup", () => {
		const resolved = resolveProtocol(() => "anthropic");
		assert.equal(resolved.api, DEFAULT_PROTOCOL);
		assert.equal(resolved.requested, "anthropic", "the bad value is reported so it can be surfaced");
	});

	test("each surface has its own default base url", () => {
		assert.equal(BASE_URL_BY_API["openai-responses"], "https://open.bigmodel.cn/api/v1");
		assert.equal(BASE_URL_BY_API["openai-completions"], "https://open.bigmodel.cn/api/paas/v4");
	});
});

describe("responses model registration", () => {
	test("every catalog id registers as openai-responses on the /api/v1 base", () => {
		for (const entry of CATALOG) {
			const built = model(entry.id);
			assert.equal(built.api, "openai-responses", entry.id);
			assert.equal(built.provider, "bigmodel", entry.id);
			assert.equal(built.baseUrl, RESPONSES_BASE_URL, entry.id);
			assert.equal(built.contextWindow, entry.contextWindow, entry.id);
			assert.equal(built.maxTokens, entry.maxTokens, entry.id);
		}
	});

	test("compat flags match the published Responses schema, not the completions one", () => {
		for (const built of CATALOG.map((e) => model(e.id))) {
			const c = built.compat as Record<string, unknown>;
			// FunctionTool is {type,name,description,parameters} — no `strict`.
			assert.equal(c.supportsStrictMode, false, built.id);
			// No prompt_cache_retention / prompt_cache_options in the spec.
			assert.equal(c.supportsLongCacheRetention, false, built.id);
			assert.equal(c.supportsExplicitPromptCacheMode, false, built.id);
			// max_output_tokens IS documented (ceiling 131072).
			assert.equal(c.supportsMaxOutputTokens, true, built.id);
			// InputMessage's role enum does include `developer`.
			assert.equal(c.supportsDeveloperRole, true, built.id);
			assert.equal(c.supportsOpenAIGrammarTools, false, built.id);
			assert.equal(c.supportsMidConvoSystemMessages, false, built.id);
			// Completions-only flags must not leak onto this surface.
			assert.equal("maxTokensField" in c, false, built.id);
			assert.equal("thinkingFormat" in c, false, built.id);
			assert.equal("zaiToolStream" in c, false, built.id);
		}
	});

	test("no thinking switch exists on this surface, so 'off' is never offered", () => {
		// Measured 2026-10-09 on GLM-4.7 / GLM-4.7-Flash: reasoning.effort "none"
		// (114 reasoning tokens), "minimal" (74), "low" (114), "medium" (113),
		// "high" (72), "max" (73), "xhigh" (56), no reasoning field (105), an
		// undocumented thinking:{type:"disabled"} (114) and do_sample:false (93)
		// are all the same within noise. Offering "off" would promise a saving the
		// gateway does not deliver.
		for (const entry of CATALOG) {
			const built = model(entry.id);
			if (!built.reasoning) {
				assert.deepEqual(getSupportedThinkingLevels(built), ["off"], `${entry.id}: non-reasoning`);
				continue;
			}
			assert.ok(!getSupportedThinkingLevels(built).includes("off"), `${entry.id}: off must not be offered`);
			assert.equal(built.thinkingLevelMap?.off, null, entry.id);
		}
	});

	test("GLM-5.3 keeps its enforced low|high|max map; others pass the scale through", () => {
		for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"]) {
			assert.deepEqual(model(id).thinkingLevelMap, GLM53_EFFORT, id);
		}
		for (const id of ["glm-4.7", "glm-5.2", "glm-5.1", "glm-4.5-flash"]) {
			assert.deepEqual(model(id).thinkingLevelMap, RESPONSES_EFFORT, id);
		}
		// Forced thinkers without an effort scale still hide only "off".
		assert.deepEqual(model("glm-4.1v-thinking-flash").thinkingLevelMap, { off: null });
		// GLM-4 generation does not think at all, on either surface.
		assert.equal(model("glm-4-flash-250414").reasoning, false);
		assert.equal(model("glm-4-flash-250414").thinkingLevelMap, undefined);
	});

	test("image limits survive the protocol switch", () => {
		assert.equal(model("glm-5.3-flash").inputLimits?.images?.resize?.maxWidth, 6000);
		assert.equal(model("glm-4.6v").inputLimits?.images?.maxPerRequest, 50);
		assert.equal(model("glm-4.7").inputLimits, undefined);
	});
});

describe("responses request shape", () => {
	test("uses input items, max_output_tokens and store:false", async () => {
		const body = await capture(model("glm-4.7"), { maxTokens: 4096, reasoning: "low" });
		assert.equal(body.max_output_tokens, 4096);
		assert.equal("max_tokens" in body, false);
		assert.equal(body.store, false, "nothing is persisted server-side by default");
		assert.equal(body.stream, true);
		assert.ok(Array.isArray(body.input));
		// pi puts the system prompt in the input list, not in `instructions`, and
		// uses the `developer` role for reasoning models because the spec's
		// InputMessage role enum lists it (accepted live 2026-10-09). The
		// completions surface gets `system` instead — its spec has no developer.
		assert.equal(body.input[0].role, "developer");
		assert.equal("instructions" in body, false);
		assert.deepEqual(body.input[1].content, [{ type: "input_text", text: "Say hi." }]);
	});

	test("sends prompt_cache_key from the session id — the reason this surface is default", async () => {
		// Documented in CreateResponseRequest as 「用于集群路由，以提高缓存命中率」
		// (cluster routing, to raise the cache hit rate). pi fills it from
		// StreamOptions.sessionId with no help from the plugin. The completions
		// spec has no such field.
		const body = await capture(model("glm-4.7"), { reasoning: "low", sessionId: "session-abc" });
		assert.equal(body.prompt_cache_key, "session-abc");
	});

	test("never sends cache-retention or store controls the spec does not define", async () => {
		const body = await capture(model("glm-5.3"), { reasoning: "high" });
		for (const field of ["prompt_cache_retention", "prompt_cache_options", "thinking", "tool_choice", "response_format"]) {
			assert.equal(field in body, false, `${field} should not be sent`);
		}
	});

	test("tools are plain function tools with no strict flag", async () => {
		const tool: Tool = {
			name: "get_weather",
			description: "Look up the weather for a city.",
			parameters: Type.Object({ city: Type.String() }),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		};
		const body = await capture(model("glm-4.7"), { reasoning: "low", tools: [tool] });
		assert.equal(body.tools.length, 1);
		assert.equal(body.tools[0].type, "function");
		assert.equal(body.tools[0].name, "get_weather");
		assert.equal("strict" in body.tools[0], false, "FunctionTool has no strict field");
	});

	test("a tool that REQUIRES strict sampling fails loudly rather than silently degrading", async () => {
		// pi-ai throws for constrainedSampling.strict === "require" when the model
		// does not support strict mode. pi's own tools use "prefer", so this is a
		// guard for third-party tools, and the honest failure is better than a
		// request the gateway would ignore.
		const tool: Tool = {
			name: "get_weather",
			description: "Look up the weather for a city.",
			parameters: Type.Object({ city: Type.String() }),
			constrainedSampling: { type: "json_schema", strict: "require" },
		};
		// The adapter reports it as a stream error rather than throwing, so assert
		// on the surfaced message: no request is built and the reason is legible.
		let errorMessage: string | undefined;
		let payloadBuilt = false;
		const stream = api.streamSimple(model("glm-4.7"), context({ tools: [tool] }), {
			apiKey: "k",
			reasoning: "low",
			onPayload: () => {
				payloadBuilt = true;
				return undefined;
			},
			fetch: (() => {
				throw new Error("network blocked by responses test");
			}) as unknown as typeof fetch,
		});
		for await (const event of stream) {
			if (event.type === "error") errorMessage = (event.error as { errorMessage?: string })?.errorMessage;
			if (event.type === "error" || event.type === "done") break;
		}
		assert.equal(payloadBuilt, false, "no request should be built");
		assert.match(errorMessage ?? "", /strict|constrained/i);
	});

	test("reasoning.effort follows the level map, and forced thinkers never see 'none'", async () => {
		const cases: [string, ModelThinkingLevel, string][] = [
			["glm-4.7", "low", "low"],
			["glm-4.7", "high", "high"],
			["glm-5.2", "max", "max"],
			["glm-5.3", "low", "low"],
		];
		for (const [id, level, effort] of cases) {
			const target = model(id);
			const body = await capture(target, { reasoning: wireLevel(target, level) });
			assert.equal(body.reasoning.effort, effort, `${id} @${level}`);
		}
		// "off" on a switchable model clamps up rather than asking for "none",
		// because the gateway would ignore it and bill the reasoning anyway.
		const off = model("glm-4.7");
		// Clamping walks UP the scale from "off", so the lowest honest level wins.
		assert.equal(clampThinkingLevel(off, "off"), "minimal");
		const body = await capture(off, { reasoning: wireLevel(off, "off") });
		assert.equal(body.reasoning.effort, "minimal");
		// And on a forced thinker pi cannot produce an illegal effort: the gateway
		// 400s on anything but low|high|max (measured for none/minimal/medium/xhigh).
		for (const level of ["off", "minimal", "medium", "xhigh"] as ModelThinkingLevel[]) {
			const target = model("glm-5.3");
			const forced = await capture(target, { reasoning: wireLevel(target, level) });
			assert.ok(["low", "high", "max"].includes(forced.reasoning.effort), `glm-5.3 @${level}: ${forced.reasoning.effort}`);
		}
	});

	test("a non-reasoning model sends no reasoning field at all", async () => {
		const body = await capture(model("glm-4-flash-250414"));
		assert.equal("reasoning" in body, false);
	});

	test("images go out the way the gateway actually reads them", async () => {
		// Live 2026-10-09: `image_url` as a STRING data URL is read correctly (a
		// 16x16 four-colour PNG came back described as red/blue/green/yellow);
		// the completions-style `image_url: {url}` object is accepted with HTTP
		// 200 and the image is silently DROPPED (input_tokens 16 vs 34, and the
		// model described a blue sky). The published schema says "string", and for
		// once the schema is right — so pi's native shape must not be rewritten.
		const body = await capture(model("glm-4.6v-flash"), {
			messages: [
				{
					role: "user",
					timestamp: Date.now(),
					content: [
						{ type: "text", text: "What colour?" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
				},
			],
		});
		const parts = body.input.flatMap((item: any) => (Array.isArray(item.content) ? item.content : []));
		const image = parts.find((part: any) => part.type === "input_image");
		assert.ok(image, "no input_image part");
		assert.equal(typeof image.image_url, "string");
		assert.equal(image.image_url, "data:image/png;base64,aGVsbG8=");
	});
});

/** What pi core hands the adapter: clamped level, with "off" as undefined. */
function wireLevel(target: Model<"openai-responses">, requested: ModelThinkingLevel): ThinkingLevel | undefined {
	const clamped = clampThinkingLevel(target, requested);
	return clamped === "off" ? undefined : clamped;
}

describe("responses stream parsing and cache accounting", () => {
	async function replay(fixture = FIXTURE, id = "glm-4.5-flash"): Promise<AssistantMessage> {
		const stream = api.streamSimple(model(id), context(), {
			apiKey: "k",
			maxTokens: 200,
			sessionId: "fixture-session-2",
			fetch: (async () =>
				new Response(fixture, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) if (event.type === "done") message = event.message as AssistantMessage;
		assert.ok(message, "no done event");
		return message;
	}

	test("reasoning_text becomes a thinking block, output_text becomes the answer", async () => {
		const message = await replay();
		assert.equal(message.stopReason, "stop");
		const thinking = message.content.find((b: any) => b.type === "thinking") as any;
		assert.match(thinking?.thinking ?? "", /reply with exactly/);
		// The signature is the reasoning item itself, which is what makes the
		// multi-turn replay work (pi pushes it back verbatim as an input item).
		assert.equal(JSON.parse(thinking.thinkingSignature).type, "reasoning");
		assert.equal(JSON.parse(thinking.thinkingSignature).encrypted_content, null);
		const text = message.content.find((b: any) => b.type === "text") as any;
		assert.equal(text?.text, "OK");
		assert.match(text?.textSignature ?? "", /msg_resp_/, "the message id is kept for replay");
	});

	test("usage.input_tokens_details.cached_tokens lands in cacheRead and out of input", async () => {
		const message = await replay();
		// Fixture: input_tokens 10, cached_tokens 4, output_tokens 24.
		assert.equal(message.usage.cacheRead, 4);
		assert.equal(message.usage.input, 6, "cached tokens must not be billed as fresh input");
		assert.equal(message.usage.output, 24);
		assert.equal(message.usage.cacheWrite, 0);
		const entry = CATALOG_BY_ID.get("glm-4.5-flash")!;
		assert.equal(entry.cny.cacheRead, 0, "free models price cache hits at zero, so cost stays 0");
		assert.equal(message.usage.cost.total, 0);
	});

	test("a paid model prices the same body at its catalog cache rate", async () => {
		const message = await replay(FIXTURE, "glm-4.7");
		const entry = CATALOG_BY_ID.get("glm-4.7")!;
		const usd = (cny: number, tokens: number) => (tokens * cnyToUsdLocal(cny)) / 1e6;
		assert.ok(Math.abs(message.usage.cost.cacheRead - usd(entry.cny.cacheRead, 4)) < 1e-9);
		assert.ok(Math.abs(message.usage.cost.input - usd(entry.cny.input, 6)) < 1e-9);
		assert.ok(message.usage.cost.total > 0);
	});

	test("an incomplete response is surfaced as a length stop, not an error", async () => {
		// The first live capture ended in `response.incomplete` with
		// incomplete_details.reason "max_output_tokens" (24-token budget eaten by
		// reasoning). pi must not treat that as a provider failure.
		const truncated = FIXTURE.replace(/"type":"response\.completed"/g, '"type":"response.incomplete"')
			.replace('"status":"completed","usage"', '"status":"incomplete","usage"')
			.replace('"incomplete_details":null', '"incomplete_details":{"reason":"max_output_tokens"}');
		const message = await replay(truncated);
		assert.equal(message.stopReason, "length");
		assert.notEqual(message.stopReason, "error");
	});
});

function cnyToUsdLocal(cny: number): number {
	return Math.round((cny / DEFAULT_CNY_PER_USD) * 1e6) / 1e6;
}
