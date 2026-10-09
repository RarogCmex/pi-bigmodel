/**
 * Responses-API probe, round 2 — 2026-10-09.
 *
 * Round 1 (`evidence-2026-10-09-responses.json`) left five questions that a
 * status code alone could not answer, and one negative that had to be
 * re-probed with a known-good control before being believed (the image probe
 * used a hand-written base64 PNG, which is exactly how a false "vision
 * unsupported" entry gets into a catalog):
 *
 *   1. is `detail: "auto"` (hard-coded by pi's responses adapter) rejected, or
 *      was round 1's image simply not a valid PNG?
 *   2. what does a `reasoning` output item look like, and does replaying it as
 *      an input item work (multi-turn preserved thinking)?
 *   3. what are the streaming event names for a COMPLETED response?
 *   4. does `reasoning.effort: "none"` actually stop GLM-4.7 from thinking?
 *   5. what is the overflow body on this surface?
 *
 * `node research/probe-responses-2.mjs`
 */
import { appendFileSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const EVIDENCE = new URL("./evidence-2026-10-09-responses.json", import.meta.url).pathname;
const env = {};
for (const line of readFileSync(new URL("../secret.env", import.meta.url).pathname, "utf8").split("\n")) {
	const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
	if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const HOST = "https://open.bigmodel.cn";
const RESP = `${HOST}/api/v1/responses`;
const CHAT = `${env.API.replace(/\/+$/, "")}/chat/completions`;
const FREE = env.KEY1;
const PAID = env.KEY6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const records = [];

/** A real 8x8 red PNG, encoded here so the control is known-good. */
function validPngDataUrl() {
	const crcTable = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable[n] = c >>> 0;
	}
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crcBuf = Buffer.alloc(4);
		crcBuf.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, crcBuf]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(8, 0);
	ihdr.writeUInt32BE(8, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor
	const raw = Buffer.concat(
		Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(8).fill(Buffer.from([255, 0, 0])))])),
	);
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
	return `data:image/png;base64,${png.toString("base64")}`;
}

async function post(label, url, body, key = FREE, { stream = false, timeoutMs = 90_000 } = {}) {
	const rec = { label, url: url.replace(HOST, "…") };
	try {
		const r = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ...body, ...(stream ? { stream: true } : {}) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		rec.status = r.status;
		const text = await r.text();
		if (stream) {
			rec.events = [...new Set([...text.matchAll(/^event: ([\w.]+)/gm)].map((m) => m[1]))];
			rec.tail = text.slice(-500);
			console.log(`${label.padEnd(50)} ${r.status} events=${rec.events.join(",")}`);
		} else {
			let j = null;
			try { j = JSON.parse(text); } catch { rec.rawBody = text.slice(0, 300); }
			rec.json = j;
			console.log(
				`${label.padEnd(50)} ${r.status} ${j?.error ? `code=${j.error.code ?? j.error.type} ${String(j.error.message).slice(0, 80)}` : `${j?.status ?? ""} out=[${(j?.output ?? []).map((o) => o.type)}] usage=${JSON.stringify(j?.usage)}`}`,
			);
		}
	} catch (e) {
		rec.status = "ERR";
		rec.error = String(e).slice(0, 200);
		console.log(`${label.padEnd(50)} ERR ${rec.error}`);
	}
	records.push(rec);
	await sleep(900);
	return rec;
}

const sys = [{ role: "system", content: "You are pi, a coding agent." }];
const ask = (text) => [{ role: "user", content: [{ type: "input_text", text }] }];

console.log("### Q1: images — is `detail` the problem, or was round 1's PNG invalid? ###");
const png = validPngDataUrl();
console.log(`      control PNG: ${png.length} chars of data URL`);
// Control first: the SAME image through chat completions, which we know works.
await post("control: completions + valid png", CHAT, { model: "glm-4.6v-flash", messages: [{ role: "user", content: [{ type: "text", text: "What colour? One word." }, { type: "image_url", image_url: { url: png } }] }], max_tokens: 8, thinking: { type: "disabled" } });
await post("responses: valid png, detail:auto", RESP, { model: "glm-4.6v-flash", input: [{ role: "user", content: [{ type: "input_text", text: "What colour? One word." }, { type: "input_image", detail: "auto", image_url: png }] }], max_output_tokens: 16 });
await post("responses: valid png, no detail", RESP, { model: "glm-4.6v-flash", input: [{ role: "user", content: [{ type: "input_text", text: "What colour? One word." }, { type: "input_image", image_url: png }] }], max_output_tokens: 16 });
await post("responses: remote url, detail:auto", RESP, { model: "glm-4.6v-flash", input: [{ role: "user", content: [{ type: "input_text", text: "What is in the picture? One word." }, { type: "input_image", detail: "auto", image_url: "https://cdn.bigmodel.cn/static/logo/register.png" }] }], max_output_tokens: 16 });
await post("responses: glm-5.3-flash + valid png", RESP, { model: "glm-5.3-flash", input: [{ role: "user", content: [{ type: "input_text", text: "What colour? One word." }, { type: "input_image", detail: "auto", image_url: png }] }], max_output_tokens: 16, reasoning: { effort: "low" } }, PAID);

console.log("\n### Q2: reasoning output item shape + replay ###");
const r1 = await post("reasoning shape (glm-4.7, effort low)", RESP, { model: "glm-4.7", input: [...sys, ...ask("What is 12*13? Answer with just the number.")], max_output_tokens: 200, reasoning: { effort: "low" } }, PAID);
const out = r1.json?.output ?? [];
const reasoningItem = out.find((o) => o.type === "reasoning");
const messageItem = out.find((o) => o.type === "message");
console.log("      reasoning item:", JSON.stringify(reasoningItem)?.slice(0, 500));
console.log("      message item:", JSON.stringify(messageItem)?.slice(0, 300));
if (reasoningItem) {
	await post("replay reasoning item + new question", RESP, {
		model: "glm-4.7",
		input: [...sys, ...ask("What is 12*13? Answer with just the number."), reasoningItem, ...(messageItem ? [messageItem] : []), ...ask("And 14*15? Just the number.")],
		max_output_tokens: 200,
		reasoning: { effort: "low" },
	}, PAID);
}

console.log("\n### Q3: streaming events for a COMPLETED response ###");
await post("stream: completed text response", RESP, { model: "glm-4.5-flash", input: [...sys, ...ask("Say hi.")], max_output_tokens: 64, reasoning: { effort: "none" } }, FREE, { stream: true });
await post("stream: completed with tool call", RESP, { model: "glm-4.5-flash", input: [...sys, ...ask("Weather in Berlin? Use the tool.")], max_output_tokens: 200, tools: [{ type: "function", name: "get_weather", description: "Look up the weather.", parameters: { type: "object", required: ["city"], properties: { city: { type: "string" } } } }] }, FREE, { stream: true });

console.log("\n### Q4: does effort:none stop GLM-4.7 thinking? ###");
for (const effort of ["none", "minimal", "low"]) {
	const r = await post(`glm-4.7 effort=${effort} (64 tokens)`, RESP, { model: "glm-4.7", input: [...sys, ...ask("What is 12*13? Answer with just the number.")], max_output_tokens: 64, reasoning: { effort } }, PAID);
	const o = r.json?.output ?? [];
	console.log(`      reasoning_tokens=${r.json?.usage?.output_tokens_details?.reasoning_tokens} items=[${o.map((x) => x.type)}] text=${JSON.stringify(o.flatMap((x) => x.content ?? []).map((c) => c.text ?? "").join("")).slice(0, 60)}`);
}
const rNoField = await post("glm-4.7 without a reasoning field", RESP, { model: "glm-4.7", input: [...sys, ...ask("What is 12*13? Answer with just the number.")], max_output_tokens: 64 }, PAID);
console.log(`      reasoning_tokens=${rNoField.json?.usage?.output_tokens_details?.reasoning_tokens} items=[${(rNoField.json?.output ?? []).map((x) => x.type)}]`);
const rComp = await post("control: completions thinking:disabled", CHAT, { model: "glm-4.7", messages: [{ role: "user", content: "What is 12*13? Answer with just the number." }], max_tokens: 64, thinking: { type: "disabled" } }, PAID);
console.log(`      completions reasoning_tokens=${rComp.json?.usage?.completion_tokens_details?.reasoning_tokens}`);

console.log("\n### Q5: overflow + tool round trip on this surface ###");
const filler = Array.from({ length: 200_000 }, (_, i) => `filler ${i} `).join("");
await post("overflow ~200K tokens (free model)", RESP, { model: "glm-4.5-flash", input: [...sys, ...ask(`${filler}\nSay ok`)], max_output_tokens: 1 }, FREE, { timeoutMs: 180_000 });

const TOOL = { type: "function", name: "get_weather", description: "Look up the weather for a city.", parameters: { type: "object", required: ["city"], properties: { city: { type: "string" } } } };
const t1 = await post("tool round trip: turn 1", RESP, { model: "glm-4.5-flash", input: [...sys, ...ask("What is the weather in Berlin? Call the tool.")], max_output_tokens: 200, tools: [TOOL] });
const fn = (t1.json?.output ?? []).find((o) => o.type === "function_call");
const rz = (t1.json?.output ?? []).find((o) => o.type === "reasoning");
console.log("      function_call:", JSON.stringify(fn)?.slice(0, 300));
if (fn) {
	await post("tool round trip: replay + output", RESP, {
		model: "glm-4.5-flash",
		input: [...sys, ...ask("What is the weather in Berlin? Call the tool."), ...(rz ? [rz] : []), fn, { type: "function_call_output", call_id: fn.call_id, output: '{"temp_c":21,"summary":"Sunny"}' }],
		max_output_tokens: 200,
		tools: [TOOL],
	});
}

appendFileSync(EVIDENCE, "\n---\n" + JSON.stringify({ stage: "responses-round-2", at: new Date().toISOString(), records: records.map((r) => ({ ...r, json: undefined, tail: r.tail?.slice(0, 200) })) }, null, 1) + "\n");
console.log(`\nevidence appended -> ${EVIDENCE}`);
