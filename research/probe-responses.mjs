/**
 * Responses-API surface probe — 2026-10-09.
 *
 * `node research/probe-responses.mjs` (keys from ../secret.env, never logged).
 *
 * Everything here is either a rejection (free) or a `max_output_tokens` <= 16
 * call; the paid-model checks run on KEY6 and cost fractions of a cent. The
 * point is to find which fields pi's openai-responses adapter sends that this
 * gateway does not document — `reasoning.summary`, `include`, `strict`,
 * `detail`, `prompt_cache_key` — before wiring the protocol up.
 */
import { appendFileSync, readFileSync } from "node:fs";

const EVIDENCE = new URL("./evidence-2026-10-09-responses.json", import.meta.url).pathname;
const env = {};
for (const line of readFileSync(new URL("../secret.env", import.meta.url).pathname, "utf8").split("\n")) {
	const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
	if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const HOST = "https://open.bigmodel.cn";
const URL_RESP = `${HOST}/api/v1/responses`;
const FREE = env.KEY1;
const PAID = env.KEY6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const records = [];
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+p7RLAAAAAElFTkSuQmCC";

async function call(label, body, key = FREE, { stream = false, timeoutMs = 60_000 } = {}) {
	const rec = { label, body: JSON.parse(JSON.stringify(body)) };
	try {
		const r = await fetch(URL_RESP, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ...body, stream }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		rec.status = r.status;
		const text = await r.text();
		if (stream) {
			const events = [...text.matchAll(/^event: ([\w.]+)/gm)].map((m) => m[1]);
			rec.events = [...new Set(events)];
			const usage = /"usage":\s*(\{[^}]*\})/.exec(text)?.[1];
			rec.usageRaw = usage;
			rec.tail = text.slice(-700);
			console.log(`${label.padEnd(52)} ${r.status} events=${rec.events.join(",")}`);
		} else {
			let j = null;
			try { j = JSON.parse(text); } catch { rec.rawBody = text.slice(0, 400); }
			if (j) {
				rec.error = j.error ?? undefined;
				rec.status2 = j.status;
				rec.usage = j.usage;
				rec.model = j.model;
				rec.outputTypes = (j.output ?? []).map((o) => o.type);
				rec.text = (j.output ?? []).flatMap((o) => o.content ?? []).map((c) => `${c.type}:${String(c.text ?? "").slice(0, 40)}`).join(" | ");
				rec.outputSample = JSON.stringify(j.output ?? []).slice(0, 500);
			}
			console.log(
				`${label.padEnd(52)} ${r.status} ${rec.error ? `code=${rec.error.code ?? rec.error.type} ${String(rec.error.message).slice(0, 90)}` : `${rec.status2 ?? ""} out=[${rec.outputTypes}] usage=${JSON.stringify(rec.usage)}`}`,
			);
		}
	} catch (e) {
		rec.status = "ERR";
		rec.error = { message: String(e).slice(0, 200) };
		console.log(`${label.padEnd(52)} ERR ${rec.error.message}`);
	}
	records.push(rec);
	await sleep(800);
	return rec;
}

const sys = [{ role: "system", content: "You are pi, a coding agent." }];
const hi = [{ role: "user", content: [{ type: "input_text", text: "Say hi." }] }];
const TOOL = { type: "function", name: "get_weather", description: "Look up the weather for a city.", parameters: { type: "object", required: ["city"], properties: { city: { type: "string" } } } };

console.log("### 1. field acceptance on free models (each accepted call bills ¥0) ###");
await call("baseline free model", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16 });
await call("reasoning.effort none", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16, reasoning: { effort: "none" } });
await call("reasoning.effort low + summary:auto", { model: "glm-4.7-flash", input: [...sys, ...hi], max_output_tokens: 16, reasoning: { effort: "low", summary: "auto" } });
await call("include:[reasoning.encrypted_content]", { model: "glm-4.7-flash", input: [...sys, ...hi], max_output_tokens: 16, reasoning: { effort: "low", summary: "auto" }, include: ["reasoning.encrypted_content"] });
await call("tools with strict:false", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16, tools: [{ ...TOOL, strict: false }] });
await call("tools with strict:true", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16, tools: [{ ...TOOL, strict: true }] });
await call("tools without strict", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16, tools: [TOOL] });
await call("prompt_cache_key + store:false", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16, prompt_cache_key: "pi-probe-session", store: false });
await call("text.format json_object", { model: "glm-4.5-flash", input: [...sys, { role: "user", content: [{ type: "input_text", text: 'Return JSON {"ok":true}' }] }], max_output_tokens: 32, text: { format: { type: "json_object" } } });
await call("temperature + top_p", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16, temperature: 1, top_p: 0.95 });
await call("developer role", { model: "glm-4.7-flash", input: [{ role: "developer", content: "You are pi." }, ...hi], max_output_tokens: 16 });
await call("stop sequence", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16, stop: ["###"] });
await call("input as plain string", { model: "glm-4.5-flash", input: "Say hi.", max_output_tokens: 16 });
await call("instructions instead of system item", { model: "glm-4.5-flash", instructions: "You are pi.", input: hi, max_output_tokens: 16 });

console.log("\n### 2. vision + image field acceptance (free VLM) ###");
await call("input_image data url + detail:auto", { model: "glm-4.6v-flash", input: [{ role: "user", content: [{ type: "input_text", text: "What colour is this pixel?" }, { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${PNG_1x1}` }] }], max_output_tokens: 16 });
await call("input_image without detail", { model: "glm-4.6v-flash", input: [{ role: "user", content: [{ type: "input_text", text: "What colour is this pixel?" }, { type: "input_image", image_url: `data:image/png;base64,${PNG_1x1}` }] }], max_output_tokens: 16 });

console.log("\n### 3. streaming event names (pi's parser must know these) ###");
await call("stream glm-4.7-flash thinking low", { model: "glm-4.7-flash", input: [...sys, ...hi], max_output_tokens: 32, reasoning: { effort: "low" } }, FREE, { stream: true });
await call("stream glm-4.5-flash + tool", { model: "glm-4.5-flash", input: [...sys, { role: "user", content: [{ type: "input_text", text: "Weather in Berlin? Use the tool." }] }], max_output_tokens: 64, tools: [TOOL] }, FREE, { stream: true });

console.log("\n### 4. limits disclosed by rejections (free) ###");
await call("max_output_tokens 99999999", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 99_999_999 });
await call("unknown model", { model: "definitely-not-a-model", input: "hi", max_output_tokens: 16 });
await call("unsupported field", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16, thinking: { type: "enabled" } });
await call("tool_choice required (not in enum)", { model: "glm-4.5-flash", input: [...sys, ...hi], max_output_tokens: 16, tools: [TOOL], tool_choice: "required" });

console.log("\n### 5. tool round trip + reasoning replay shape (free) ###");
const first = await call("tool call round trip: first turn", { model: "glm-4.5-flash", input: [...sys, { role: "user", content: [{ type: "input_text", text: "What is the weather in Berlin? Call the tool." }] }], max_output_tokens: 128, tools: [TOOL], reasoning: { effort: "low" } });
const fnCall = (() => {
	try { return JSON.parse(first.outputSample ?? "null"); } catch { return null; }
})();
if (Array.isArray(fnCall)) {
	const call_ = fnCall.find((o) => o.type === "function_call");
	const reasoningItem = fnCall.find((o) => o.type === "reasoning");
	console.log("      function_call item:", JSON.stringify(call_)?.slice(0, 300));
	console.log("      reasoning item:", JSON.stringify(reasoningItem)?.slice(0, 400));
	if (call_) {
		await call("tool round trip: replay with function_call_output", {
			model: "glm-4.5-flash",
			input: [
				...sys,
				{ role: "user", content: [{ type: "input_text", text: "What is the weather in Berlin? Call the tool." }] },
				...(reasoningItem ? [reasoningItem] : []),
				call_,
				{ type: "function_call_output", call_id: call_.call_id ?? call_.id, output: '{"temp_c":21,"summary":"Sunny"}' },
			],
			max_output_tokens: 128,
			tools: [TOOL],
		});
	}
}

console.log("\n### 6. paid model on Responses (KEY6, tiny) ###");
await call("glm-5.3 reasoning low + include", { model: "glm-5.3", input: [...sys, ...hi], max_output_tokens: 16, reasoning: { effort: "low", summary: "auto" }, include: ["reasoning.encrypted_content"] }, PAID);
await call("glm-5.3 reasoning medium (docs: only low/high/max)", { model: "glm-5.3", input: [...sys, ...hi], max_output_tokens: 16, reasoning: { effort: "medium" } }, PAID);
await call("glm-4.7 reasoning none", { model: "glm-4.7", input: [...sys, ...hi], max_output_tokens: 16, reasoning: { effort: "none" } }, PAID);
await call("glm-5.3-flash (VLM) text only", { model: "glm-5.3-flash", input: [...sys, ...hi], max_output_tokens: 16, reasoning: { effort: "low" } }, PAID);
await call("zero-balance key on paid model (1113?)", { model: "glm-4.5-air", input: [...sys, ...hi], max_output_tokens: 16 });

console.log("\n### 7. prompt_cache_key effect on cache hits (free model) ###");
const prefix = Array.from({ length: 60 }, (_, i) => `${i}. Stable prefix line for the Responses prompt_cache_key routing probe.`).join("\n");
for (const withKey of [false, true]) {
	for (const attempt of [1, 2]) {
		await call(`cache ${withKey ? "with" : "without"} prompt_cache_key #${attempt}`, {
			model: "glm-4.5-flash",
			input: [{ role: "system", content: prefix }, { role: "user", content: [{ type: "input_text", text: `q${attempt}` }] }],
			max_output_tokens: 1,
			...(withKey ? { prompt_cache_key: "pi-cache-probe-fixed-key" } : {}),
		});
		await sleep(6000);
	}
}

appendFileSync(EVIDENCE, JSON.stringify({ at: new Date().toISOString(), records }, null, 1) + "\n");
console.log(`\nevidence -> ${EVIDENCE}`);
