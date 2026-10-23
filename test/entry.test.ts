/**
 * Entry-wiring tests against a fake pi.
 *
 * The point of this file is the ORDER pi actually runs things in, which no
 * unit test of `errors.ts` can see:
 *
 *   1. `message_end` is emitted to extensions and the returned message replaces
 *      the stored one **in place** — pi deletes every key of the object it
 *      already put in agent state and `Object.assign`s the replacement over it
 *      (`pi/dist/core/agent-session.js` `_replaceMessageInPlace`, 1.1.0), so
 *      object identity survives and every later reader sees the rewrite;
 *   2. only then does `turn_end` fire, with that same (already rewritten)
 *      message object.
 *
 * A `turn_end` handler that re-classifies `errorMessage` from scratch therefore
 * sees its own rewrite, not the gateway's body — which is how the persistent
 * billing hint became unreachable while the auth one survived only because
 * `clarifyErrorMessage` quotes the original text inside the rewrite. Both are
 * asserted below, in pi's order, through the real extension module.
 */

import assert from "node:assert/strict";
import test, { describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import extension from "../index.ts";

type Handler = (event: any, ctx: any) => any;

interface FakePi {
	handlers: Map<string, Handler[]>;
	registered: unknown[];
	tools: unknown[];
	commands: unknown[];
	on(event: string, handler: Handler): () => void;
	registerProvider(provider: unknown): void;
	registerTool(tool: unknown): void;
	registerCommand(name: string, command: unknown): void;
	emit(event: string, payload: any, ctx?: any): any;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Handler[]>();
	const registered: unknown[] = [];
	const tools: unknown[] = [];
	const commands: unknown[] = [];
	return {
		handlers,
		registered,
		tools,
		commands,
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				handlers.set(event, list.filter((h) => h !== handler));
			};
		},
		registerProvider(provider) {
			registered.push(provider);
		},
		registerTool(tool) {
			tools.push(tool);
		},
		registerCommand(name, command) {
			commands.push({ name, command });
		},
		emit(event, payload, ctx) {
			// pi applies the first handler result; the chain is not additive here
			// because this plugin registers one handler per event.
			const list = handlers.get(event) ?? [];
			let result: any;
			for (const handler of list) result = handler(payload, ctx) ?? result;
			return result;
		},
	};
}

/** pi's `_replaceMessageInPlace`: mutate the stored object, keep its identity. */
function replaceInPlace(target: Record<string, unknown>, replacement: Record<string, unknown>): void {
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, replacement);
}

function errorStop(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		stopReason: "error",
		errorMessage,
		provider: "bigmodel",
		content: [],
	} as unknown as AssistantMessage;
}

/** message_end → in-place replacement → turn_end, exactly as pi sequences them. */
function runTurn(pi: FakePi, raw: string, { hasUI = true, entries = [] as unknown[] } = {}) {
	const message = errorStop(raw) as unknown as Record<string, unknown>;
	const endResult = pi.emit("message_end", { message });
	if (endResult?.message) replaceInPlace(message, endResult.message as Record<string, unknown>);
	const turnResult = pi.emit(
		"turn_end",
		{ outcome: "error", message, entries },
		{ hasUI },
	);
	return { message, turnResult };
}

const LIVE = {
	balance1113: '429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}',
	quota1310: '429: {"code":"1310","message":"您已达到每周/每月使用上限"}',
	plan1315: '429: {"code":"1315","message":"该 API Key 仅限企业编程套餐场景使用"}',
	auth1000: '401: {"code":"1000","message":"身份验证失败。"}',
	throttle1305: '429: {"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}',
	overflow1261: '400: {"code":"1261","message":"Prompt exceeds max length"}',
} as const;

describe("extension wiring", () => {
	let pi: FakePi;
	const realProtocol = process.env.BIGMODEL_PROTOCOL;
	const realAgentDir = process.env.PI_CODING_AGENT_DIR;
	// A hermetic agent dir: index.ts reads the search-sidecar config from it at
	// registration, and the developer's real ~/.pi/agent must not leak in.
	let tmpAgentDir: string;

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-bm-entry-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		pi = fakePi();
		extension(pi as never);
	});
	afterEach(() => {
		if (realProtocol === undefined) delete process.env.BIGMODEL_PROTOCOL;
		else process.env.BIGMODEL_PROTOCOL = realProtocol;
		if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = realAgentDir;
		rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	test("registers the provider and the two rewrite hooks", () => {
		assert.equal(pi.registered.length, 1);
		assert.ok(pi.handlers.get("message_end")?.length, "message_end not wired");
		assert.ok(pi.handlers.get("turn_end")?.length, "turn_end not wired");
	});

	test("search sidecar: tool + command registered by default, section only on codemode", () => {
		// No config file → exposure defaults to codemode.
		assert.equal(pi.tools.length, 1);
		assert.equal((pi.tools[0] as { name?: string }).name, "bigmodel_search");
		assert.equal((pi.tools[0] as { exposure?: string }).exposure, "codemode");
		assert.equal(pi.commands.length, 1);
		assert.equal((pi.commands[0] as { name?: string }).name, "bigmodel");
		const event: any = { messageType: "user", prompt: "hi", systemPromptOptions: { sections: {} } };
		pi.emit("before_agent_start", event);
		assert.ok(event.systemPromptOptions.sections.bigmodel.includes("bigmodel_search"));
		// Since pi 1.2.0 the event is a union on `messageType`, and a run started by
		// `pi.sendMessage(…, { triggerTurn: true })` arrives as "custom" with no
		// `prompt`. The handler writes only `systemPromptOptions` (present on both
		// variants), so it deliberately carries no `messageType === "user"` guard: a
		// custom run needs the section exactly as much as a prompt does.
		const custom: any = {
			messageType: "custom",
			message: { role: "custom", customType: "bigmodel-test", content: [], display: false },
			systemPromptOptions: { sections: {} },
		};
		pi.emit("before_agent_start", custom);
		assert.ok(custom.systemPromptOptions.sections.bigmodel.includes("bigmodel_search"), "custom run lost the section");
	});

	test("search sidecar: exposure=off registers neither tool nor section", () => {
		const off = fakePi();
		writeFileSync(join(tmpAgentDir, "pi-bigmodel.json"), JSON.stringify({ searchExposure: "off" }), "utf8");
		extension(off as never);
		assert.equal(off.tools.length, 0);
		const event: any = { messageType: "user", prompt: "hi", systemPromptOptions: { sections: {} } };
		off.emit("before_agent_start", event);
		assert.equal(event.systemPromptOptions.sections.bigmodel, undefined);
	});

	test("registers the Responses surface by default", () => {
		const provider = pi.registered[0] as { id: string; baseUrl: string; getModels(): { api: string }[] };
		assert.equal(provider.id, "bigmodel");
		assert.equal(provider.baseUrl, "https://open.bigmodel.cn/api/v1");
		for (const model of provider.getModels()) assert.equal(model.api, "openai-responses");
	});

	test("a permanent 429 reaches the persistent billing hint, through pi's in-place rewrite", () => {
		// This is the regression the ordering hides: by turn_end the message is
		// already the rewrite, so classifying the gateway body again finds nothing.
		const { message, turnResult } = runTurn(pi, LIVE.balance1113);
		assert.match(String((message as { errorMessage: string }).errorMessage), /BigModel \(Zhipu AI\)/);
		const entries = (turnResult?.entries ?? []) as { customType?: string; content?: string }[];
		const billing = entries.find((e) => e.customType === "bigmodel-billing-help");
		assert.ok(billing, `no billing entry; got ${JSON.stringify(entries.map((e) => e.customType))}`);
		assert.match(billing.content ?? "", /bigmodel\.cn\/finance/);
	});

	test("quota and plan rewrites pick their own persistent hint", () => {
		const quota = runTurn(pi, LIVE.quota1310).turnResult?.entries as { customType?: string; content?: string }[];
		assert.ok(quota?.some((e) => e.customType === "bigmodel-billing-help" && /bigmodel\.cn\/finance/.test(e.content ?? "")));

		const plan = runTurn(pi, LIVE.plan1315).turnResult?.entries as { customType?: string; content?: string }[];
		assert.ok(plan?.some((e) => e.customType === "bigmodel-billing-help" && /coding-plan/.test(e.content ?? "")));
	});

	test("the auth hint still fires after its own rewrite", () => {
		const { turnResult } = runTurn(pi, LIVE.auth1000);
		const entries = (turnResult?.entries ?? []) as { customType?: string; content?: string }[];
		const auth = entries.find((e) => e.customType === "bigmodel-auth-help");
		assert.ok(auth, `no auth entry; got ${JSON.stringify(entries.map((e) => e.customType))}`);
		assert.match(auth.content ?? "", /\/login bigmodel/);
	});

	test("transient throttles and overflow produce no persistent entry", () => {
		for (const raw of [LIVE.throttle1305, LIVE.overflow1261]) {
			const { turnResult } = runTurn(pi, raw);
			const entries = (turnResult?.entries ?? []) as { customType?: string }[];
			assert.deepEqual(
				entries.filter((e) => e.customType?.startsWith("bigmodel-")).map((e) => e.customType),
				[],
				raw,
			);
		}
	});

	test("print mode gets no appended entry (it would hide the error text)", () => {
		const { turnResult } = runTurn(pi, LIVE.balance1113, { hasUI: false });
		assert.equal(turnResult, undefined);
	});

	test("a repeated failure does not stack duplicate hints", () => {
		const first = runTurn(pi, LIVE.balance1113);
		const entries = (first.turnResult?.entries ?? []) as { customType?: string }[];
		assert.equal(entries.filter((e) => e.customType === "bigmodel-billing-help").length, 1);
		// The second failure must not re-emit: the handler returns nothing when the
		// customType is already in the transcript, so pi keeps the single entry.
		const second = runTurn(pi, LIVE.balance1113, { entries });
		assert.equal(second.turnResult, undefined, "a duplicate hint was emitted");
	});

	test("our own base-URL diagnosis is never re-read as an auth failure", () => {
		// The shape pi really produces: `bigmodel API error (403): {…}` wraps our body,
		// so the text no longer starts with our header — only the ASCII tag survives.
		// Live 2026-10-23 this was a false positive: the user was told to check a
		// working key while the base URL was the problem.
		const raw =
			'bigmodel API error (403): {"code":"403","message":"BigModel (Zhipu AI): [baseurl] ' +
			'запрос ушёл на https://open.bigmodel.cn/api/v1/chat/completions и получил 403. "}';
		const { message, turnResult } = runTurn(pi, raw);
		assert.equal((message as { errorMessage: string }).errorMessage, raw, "the diagnosis was rewritten");
		assert.equal(turnResult, undefined, "an auth hint was appended for a base-URL problem");
	});

	test("the overflow rewrite is what turn_end sees, and it is not a billing case", () => {
		const { message } = runTurn(pi, LIVE.overflow1261);
		assert.match(String((message as { errorMessage: string }).errorMessage), /^context_length_exceeded:/);
	});
});

describe("protocol selection is surfaced, not swallowed", () => {
	const realProtocol = process.env.BIGMODEL_PROTOCOL;
	afterEach(() => {
		if (realProtocol === undefined) delete process.env.BIGMODEL_PROTOCOL;
		else process.env.BIGMODEL_PROTOCOL = realProtocol;
	});

	test("an unrecognized BIGMODEL_PROTOCOL still registers, on the default surface", () => {
		process.env.BIGMODEL_PROTOCOL = "completio"; // typo: must not silently mean completions
		const pi = fakePi();
		extension(pi as never);
		const provider = pi.registered[0] as { baseUrl: string; getModels(): { api: string }[] };
		assert.equal(provider.baseUrl, "https://open.bigmodel.cn/api/v1");
		assert.equal(provider.getModels()[0].api, "openai-responses");
	});

	test("BIGMODEL_PROTOCOL=completions really registers completions", () => {
		process.env.BIGMODEL_PROTOCOL = "completions";
		const pi = fakePi();
		extension(pi as never);
		const provider = pi.registered[0] as { baseUrl: string; getModels(): { api: string }[] };
		assert.equal(provider.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
		for (const model of provider.getModels()) assert.equal(model.api, "openai-completions");
	});
});

/**
 * A BIGMODEL_BASE_URL that cannot work is the one misconfiguration whose symptom
 * is an opaque 404 on the first turn, so it gets the same `session_start` channel
 * as the protocol typo. What it must NOT do is change the registered URL: a proxy
 * may legitimately serve the exact path a human reads as a mistake.
 */
describe("a base URL that cannot work is surfaced, not corrected", () => {
	const realBase = process.env.BIGMODEL_BASE_URL;
	const realProtocol = process.env.BIGMODEL_PROTOCOL;
	const realAgentDir = process.env.PI_CODING_AGENT_DIR;
	let tmpAgentDir: string;

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-bm-baseurl-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		delete process.env.BIGMODEL_PROTOCOL;
	});
	afterEach(() => {
		for (const [name, real] of [
			["BIGMODEL_BASE_URL", realBase],
			["BIGMODEL_PROTOCOL", realProtocol],
			["PI_CODING_AGENT_DIR", realAgentDir],
		] as const) {
			if (real === undefined) delete process.env[name];
			else process.env[name] = real;
		}
		rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	function uiCtx(hasUI = true) {
		const notes: { message: string; level?: string }[] = [];
		return {
			notes,
			ctx: {
				hasUI,
				ui: { notify: (message: string, level?: string) => notes.push({ message, level }) },
			},
		};
	}

	test("the override is registered verbatim and the warning names the 404 URL", () => {
		process.env.BIGMODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
		const pi = fakePi();
		extension(pi as never);
		// No silent "fixing": what the user set is what pi will use.
		const provider = pi.registered[0] as { baseUrl: string };
		assert.equal(provider.baseUrl, "https://open.bigmodel.cn/api/paas/v4");

		const { notes, ctx } = uiCtx();
		pi.emit("session_start", {}, ctx);
		const warning = notes.find((n) => n.level === "warning");
		assert.ok(warning, "no warning was emitted");
		assert.match(warning.message, /api\/paas\/v4\/responses/, "the doomed URL must be spelled out");
		assert.match(warning.message, /https:\/\/open\.bigmodel\.cn\/api\/v1/, "the fix must be spelled out");
	});

	test("a matching base URL and a bare proxy host stay silent", () => {
		for (const override of ["https://open.bigmodel.cn/api/v1", "https://proxy.example.com"]) {
			process.env.BIGMODEL_BASE_URL = override;
			const pi = fakePi();
			extension(pi as never);
			const { notes, ctx } = uiCtx();
			pi.emit("session_start", {}, ctx);
			assert.equal(notes.length, 0, `${override} produced a warning`);
		}
	});

	test("print mode has no channel, so it stays silent instead of corrupting output", () => {
		process.env.BIGMODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
		const pi = fakePi();
		extension(pi as never);
		const { notes, ctx } = uiCtx(false);
		pi.emit("session_start", {}, ctx);
		assert.equal(notes.length, 0);
	});
});
