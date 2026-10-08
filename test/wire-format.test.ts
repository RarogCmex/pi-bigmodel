/**
 * Wire-format tests against pi-ai's REAL openai-completions adapter.
 *
 * Every compat flag in `models.ts` exists to change these bytes, and a wrong
 * guess only fails at runtime against a paid API — so the outgoing body is
 * captured through `onPayload` with a `fetch` stub that refuses the call, and
 * the incoming direction is exercised with recorded gateway bodies. Nothing here
 * touches the network (`test/no-network.ts` also blocks it globally).
 *
 * Recorded live evidence: `research/evidence-2026-10-09.json` (pi 1.1.0 run).
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai";
import { clampThinkingLevel, normalizeContext, Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, ModelThinkingLevel, ThinkingLevel, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { CATALOG, CATALOG_BY_ID } from "../catalog.ts";
import { DEFAULT_BASE_URL, DEFAULT_CNY_PER_USD, entryToModel } from "../models.ts";

const api = openAICompletionsApi();

const weatherTool: Tool = {
	name: "get_weather",
	description: "Look up the weather for a city.",
	parameters: Type.Object({ city: Type.String({ description: "City name" }) }),
};

function model(id: string): Model<"openai-completions"> {
	const entry = CATALOG_BY_ID.get(id);
	assert.ok(entry, `${id} missing from catalog`);
	return entryToModel(entry, DEFAULT_BASE_URL, DEFAULT_CNY_PER_USD) as Model<"openai-completions">;
}

/**
 * What pi core actually hands the adapter for a requested thinking level:
 * `clampThinkingLevel` first (agent-session `_clampThinkingLevel`), then "off"
 * becomes `undefined` (`core/model-runtime.js:502`). Tests must go through this,
 * because a forced thinker never sees "off" in a real session — pi clamps it up
 * to the lowest level the model supports.
 */
function wireLevel(target: Model<"openai-completions">, requested: ModelThinkingLevel): ThinkingLevel | undefined {
	const clamped = clampThinkingLevel(target, requested);
	return clamped === "off" ? undefined : clamped;
}

function context(overrides: Partial<Context> = {}): TranscriptContext {
	return normalizeContext({
		systemPrompt: "You are pi, a coding agent.",
		messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
		...overrides,
	});
}

/**
 * Run a stream to its (expected) failure and return the body it would have sent.
 *
 * JSON round-tripped on purpose: pi's `buildParams` assigns several fields the
 * literal value `undefined` (`prompt_cache_key`, `prompt_cache_retention`), so a
 * `key in body` check would report them as present even though the serialized
 * request never carries them. Asserting on the round-tripped object tests the
 * actual wire bytes.
 */
async function capture(
	target: Model<"openai-completions">,
	options: { reasoning?: ThinkingLevel; maxTokens?: number; tools?: Tool[]; messages?: Context["messages"] } = {},
): Promise<Record<string, any>> {
	let payload: Record<string, any> | undefined;
	// Tools go through the CONTEXT, not stream options: pi resolves them per
	// transcript (`resolveTranscriptTools`) and only then emits `tools`/`tool_stream`.
	const ctx = context({
		...(options.messages ? { messages: options.messages } : {}),
		...(options.tools ? { tools: options.tools } : {}),
	});
	const stream = api.streamSimple(target, ctx, {
		apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb",
		reasoning: options.reasoning,
		maxTokens: options.maxTokens ?? 2048,
		onPayload: (body) => {
			payload = body as Record<string, any>;
			return undefined;
		},
		fetch: (() => {
			throw new Error("network blocked by wire-format test");
		}) as unknown as typeof fetch,
	});
	for await (const event of stream) {
		if (event.type === "error" || event.type === "done") break;
	}
	assert.ok(payload, "adapter never built a request payload");
	return JSON.parse(JSON.stringify(payload));
}

describe("request shape common to every BigModel model", () => {
	test("posts to the CN chat-completions endpoint", async () => {
		let url: string | undefined;
		const stream = api.streamSimple(model("glm-4.5-flash"), context(), {
			apiKey: "k",
			fetch: ((u: any) => {
				url = String(u);
				throw new Error("blocked");
			}) as unknown as typeof fetch,
		});
		for await (const event of stream) if (event.type === "error" || event.type === "done") break;
		assert.equal(url, `${DEFAULT_BASE_URL}/chat/completions`);
	});

	test("uses max_tokens, not max_completion_tokens", async () => {
		const body = await capture(model("glm-4.5-flash"), { maxTokens: 4096 });
		assert.equal(body.max_tokens, 4096);
		assert.equal("max_completion_tokens" in body, false);
	});

	test("asks for streaming usage so token/cache accounting works", async () => {
		const body = await capture(model("glm-4.5-flash"));
		assert.equal(body.stream, true);
		assert.deepEqual(body.stream_options, { include_usage: true });
	});

	test("never sends fields the chat-completions spec does not define", async () => {
		// openapi.json → ChatCompletionTextRequest (read 2026-10-09) has no store,
		// prompt_cache_key, prompt_cache_retention, priority or tool_choice-by-default
		// field. The gateway was probed live: it answers 200 and ignores all three
		// cache/store fields, so "accepted" is not a reason to send them.
		const body = await capture(model("glm-5.3"), { reasoning: "high", tools: [weatherTool] });
		for (const field of ["store", "prompt_cache_key", "prompt_cache_retention", "priority", "response_format", "tool_choice"]) {
			assert.equal(field in body, false, `${field} should not be sent`);
		}
	});

	test("uses the system role, never developer", async () => {
		for (const id of ["glm-4.5-flash", "glm-5.3"]) {
			const body = await capture(model(id), { reasoning: id === "glm-5.3" ? "high" : undefined });
			assert.equal(body.messages[0].role, "system");
			assert.equal(
				body.messages.some((m: any) => m.role === "developer"),
				false,
				id,
			);
		}
	});

	test("tools carry the gateway-specific tool_stream flag", async () => {
		const body = await capture(model("glm-4.7"), { tools: [weatherTool] });
		assert.equal(body.tool_stream, true, "zaiToolStream must reach the wire");
		assert.equal(body.tools.length, 1);
		const fn = body.tools[0].function;
		assert.equal(fn.name, "get_weather");
		assert.deepEqual(fn.parameters.properties.city, { type: "string", description: "City name" });
		assert.equal(body.tools[0].type, "function");
	});

	test("supportsStrictMode lets a constrained tool send strict:true (pi >= 1.1 semantics)", async () => {
		// Since pi-ai 1.1.0 `strict` is decided per TOOL, not per provider:
		// `resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false)`
		// returns true only when the tool opts in via `constrainedSampling` and the
		// schema can be made strict. Our flag is therefore a permission: without it
		// pi's own constrained tools (e.g. `read`, strict:"prefer") would fall back.
		// BigModel accepts `strict: true` live (2026-09-24, re-checked 2026-10-09).
		const plain = await capture(model("glm-4.7"), { tools: [weatherTool] });
		assert.equal(plain.tools[0].function.strict, false, "a tool that did not ask for strict gets strict:false");

		const constrained: Tool = {
			...weatherTool,
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		};
		const body = await capture(model("glm-4.7"), { tools: [constrained] });
		const fn = body.tools[0].function;
		assert.equal(fn.strict, true);
		assert.equal(fn.parameters.additionalProperties, false, "pi tightens the schema when strict is on");
		assert.deepEqual(fn.parameters.required, ["city"]);
	});

	test("tool_stream is not sent when there are no tools", async () => {
		const body = await capture(model("glm-4.7"));
		assert.equal("tool_stream" in body, false);
	});
});

describe("thinking semantics per ThinkingControl kind", () => {
	test("none: no thinking field at all", async () => {
		const body = await capture(model("glm-4-flash-250414"));
		assert.equal("thinking" in body, false);
		assert.equal("reasoning_effort" in body, false);
	});

	test("dynamic: enabled + clear_thinking:false when a level is chosen", async () => {
		const body = await capture(model("glm-4.7"), { reasoning: "high" });
		assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: false });
		// reasoning_effort is GLM-5.2+ only; the gateway silently accepts it on
		// GLM-4.7 (probed 2026-10-09), so silence is not permission.
		assert.equal("reasoning_effort" in body, false);
	});

	test("dynamic: 'off' really sends thinking.type=disabled", async () => {
		// GLM-4.7 and GLM-4.5V were forced thinkers until 2026-10-09; both now
		// honour `disabled` (reasoning_tokens 0 on a 64-token answer).
		// pi spells "off" as `reasoning: undefined` (ThinkingLevel has no "off").
		for (const id of ["glm-4.7", "glm-4.5v", "glm-5.1", "glm-4.5-flash"]) {
			const target = model(id);
			assert.equal(clampThinkingLevel(target, "off"), "off", `${id}: off must stay off`);
			const body = await capture(target, { reasoning: wireLevel(target, "off") });
			assert.deepEqual(body.thinking, { type: "disabled" }, id);
			assert.equal("reasoning_effort" in body, false, id);
		}
	});

	test("effort (glm-5.2): the full scale maps through thinkingLevelMap", async () => {
		const cases: [ThinkingLevel, string][] = [
			["minimal", "minimal"],
			["low", "low"],
			["medium", "medium"],
			["high", "high"],
			["xhigh", "xhigh"],
			["max", "max"],
		];
		for (const [level, effort] of cases) {
			const body = await capture(model("glm-5.2"), { reasoning: level });
			assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: false }, level);
			assert.equal(body.reasoning_effort, effort, level);
		}
		// "off" maps to the documented `none`, which makes GLM-5.2 give up thinking.
		const off = await capture(model("glm-5.2"), { reasoning: wireLevel(model("glm-5.2"), "off") });
		assert.deepEqual(off.thinking, { type: "disabled" });
		assert.equal("reasoning_effort" in off, false);
	});

	test("always (glm-5.3): pi can never emit thinking.type=disabled", async () => {
		// The gateway answers 400 code 1210 「该模型始终思考」 to `disabled`
		// (re-verified live 2026-10-09), so this is the invariant that keeps a
		// forced thinker usable at every pi thinking level, including "off".
		for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"]) {
			const target = model(id);
			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ModelThinkingLevel[]) {
				assert.notEqual(clampThinkingLevel(target, level), "off", `${id}: off survived clamping`);
				const body = await capture(target, { reasoning: wireLevel(target, level) });
				assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: false }, `${id} @${level}`);
				// Only low|high|max are legal; anything else is a 400 (probed live
				// 2026-10-09: reasoning_effort "medium" → 400/1210).
				assert.ok(["low", "high", "max"].includes(String(body.reasoning_effort)), `${id} @${level}: ${body.reasoning_effort}`);
			}
		}
	});

	test("always without effort (glm-4.1v-thinking-flash): no reasoning_effort", async () => {
		const target = model("glm-4.1v-thinking-flash");
		for (const level of ["off", "low", "high"] as ModelThinkingLevel[]) {
			const body = await capture(target, { reasoning: wireLevel(target, level) });
			assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: false }, level);
			assert.equal("reasoning_effort" in body, false, level);
		}
	});

	test("every catalog id builds a request at every level it offers", async () => {
		// Sweep: a compat-flag regression anywhere in the catalog shows up as a
		// thrown payload build, not as a silent wrong field.
		for (const entry of CATALOG) {
			const target = model(entry.id);
			const levels: ModelThinkingLevel[] = target.reasoning ? ["off", "low", "high"] : ["off"];
			for (const level of levels) {
				if (clampThinkingLevel(target, level) === "off" && entry.thinking.kind === "always") {
					assert.fail(`${entry.id}: forced thinker accepted "off"`);
				}
				const body = await capture(target, { reasoning: wireLevel(target, level), tools: [weatherTool] });
				assert.equal(body.model, entry.id);
				assert.ok(Array.isArray(body.messages) && body.messages.length >= 2, entry.id);
			}
		}
	});
});

describe("preserved thinking: clear_thinking:false must be paired with a replay", () => {
	test("a signed thinking block is replayed as reasoning_content", async () => {
		// BigModel's docs (capabilities/thinking-mode.md, read 2026-10-09): on the
		// standard API preserved thinking is opt-in via clear_thinking:false AND
		// requires the previous reasoning_content to be passed back unmodified,
		// otherwise it "降低效果并影响缓存命中". pi-ai signs reasoning deltas it
		// parsed from `reasoning_content` and replays them, so the two halves match.
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "The user asked for a product.", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "156" },
			],
			stopReason: "stop",
			usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			errorMessage: undefined,
			provider: "bigmodel",
			api: "openai-completions",
			model: "glm-4.7",
			timestamp: Date.now(),
		} as unknown as AssistantMessage;
		const body = await capture(model("glm-4.7"), {
			reasoning: "high",
			messages: [
				{ role: "user", content: "12*13?", timestamp: Date.now() },
				assistant,
				{ role: "user", content: "and 14*15?", timestamp: Date.now() },
			],
		});
		const replayed = body.messages.find((m: any) => m.role === "assistant");
		assert.equal(replayed.reasoning_content, "The user asked for a product.");
		assert.equal(replayed.content, "156", "the visible answer must not absorb the reasoning text");
	});

	test("a cross-model transcript folds reasoning into text instead of replaying it", () => {
		// Guard for the fixture above: pi-ai only replays signed thinking when the
		// assistant message came from the SAME provider/api/model
		// (api/transform-messages.js `isSameModel`). If that ever changes, the
		// preserved-thinking contract with the gateway changes with it.
		const assistant = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "bigmodel",
			model: "glm-4.7",
			content: [{ type: "thinking", thinking: "stale reasoning", thinkingSignature: "reasoning_content" }],
		} as unknown as AssistantMessage;
		return capture(model("glm-4.7"), {
			reasoning: "high",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }, assistant],
		}).then((body) => {
			const replayed = body.messages.find((m: any) => m.role === "assistant");
			assert.equal(replayed.reasoning_content, undefined);
			assert.match(JSON.stringify(replayed.content), /stale reasoning/);
		});
	});
});

describe("incoming usage: the gateway's cache numbers land in pi's accounting", () => {
	/**
	 * Shape recorded live 2026-10-09 (glm-4.7, 2329 prompt tokens of which 2304
	 * were a cache hit; see research/evidence-2026-10-09.json).
	 */
	function sse(usage: Record<string, unknown>, modelId = "glm-4.7") {
		const chunks = [
			{ id: "r", object: "chat.completion.chunk", model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
			{ id: "r", object: "chat.completion.chunk", model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			{ id: "r", object: "chat.completion.chunk", model: modelId, choices: [], usage },
		];
		return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
	}

	async function run(usage: Record<string, unknown>, id = "glm-4.7") {
		const stream = api.streamSimple(model(id), context(), {
			apiKey: "k",
			maxTokens: 8,
			fetch: (async () => new Response(sse(usage, id), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "done") message = event.message as AssistantMessage;
		}
		assert.ok(message, "no done event");
		return message;
	}

	test("prompt_tokens_details.cached_tokens becomes cacheRead and leaves input", async () => {
		const message = await run({
			prompt_tokens: 2329,
			completion_tokens: 5,
			total_tokens: 2334,
			completion_tokens_details: { reasoning_tokens: 0 },
			prompt_tokens_details: { cached_tokens: 2304 },
		});
		assert.equal(message.stopReason, "stop");
		assert.equal(message.usage.cacheRead, 2304);
		assert.equal(message.usage.input, 25, "cached tokens must not be billed as fresh input");
		assert.equal(message.usage.output, 5);
	});

	test("cache hits are billed at the catalog's cacheRead rate, not the input rate", async () => {
		const message = await run({
			prompt_tokens: 2329,
			completion_tokens: 5,
			total_tokens: 2334,
			prompt_tokens_details: { cached_tokens: 2304 },
		});
		const entry = CATALOG_BY_ID.get("glm-4.7")!;
		const usdPerCny = 1 / DEFAULT_CNY_PER_USD;
		const expectedRead = ((2304 * entry.cny.cacheRead) / 1e6) * usdPerCny;
		const expectedInput = ((25 * entry.cny.input) / 1e6) * usdPerCny;
		assert.ok(Math.abs(message.usage.cost.cacheRead - expectedRead) < 1e-9, `cacheRead ${message.usage.cost.cacheRead}`);
		assert.ok(Math.abs(message.usage.cost.input - expectedInput) < 1e-9, `input ${message.usage.cost.input}`);
		assert.ok(message.usage.cost.cacheRead < message.usage.cost.input * 100, "a cache hit must be cheaper per token");
	});

	test("a response without cache details accounts as a plain miss", async () => {
		const message = await run({ prompt_tokens: 18, completion_tokens: 2, total_tokens: 20 });
		assert.equal(message.usage.cacheRead, 0);
		assert.equal(message.usage.input, 18);
	});

	test("reasoning_content deltas are collected as thinking and counted as output", async () => {
		const stream = api.streamSimple(model("glm-4.7"), context(), {
			apiKey: "k",
			maxTokens: 64,
			fetch: (async () =>
				new Response(
					[
						`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "glm-4.7", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "12*13 = " }, finish_reason: null }] })}\n\n`,
						`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "glm-4.7", choices: [{ index: 0, delta: { content: "156" }, finish_reason: null }] })}\n\n`,
						`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "glm-4.7", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
						`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "glm-4.7", choices: [], usage: { prompt_tokens: 18, completion_tokens: 64, total_tokens: 82, completion_tokens_details: { reasoning_tokens: 62 } } })}\n\n`,
						"data: [DONE]\n\n",
					].join(""),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)) as unknown as typeof fetch,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) if (event.type === "done") message = event.message as AssistantMessage;
		assert.ok(message);
		const thinking = message.content.find((b: any) => b.type === "thinking") as any;
		assert.equal(thinking?.thinking, "12*13 = ");
		assert.equal(thinking?.thinkingSignature, "reasoning_content", "signature is what makes the replay work");
		assert.equal(message.usage.reasoning, 62);
	});
});
