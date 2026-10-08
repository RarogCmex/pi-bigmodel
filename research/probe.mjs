/**
 * Live evidence probe — 2026-10-09, pi 1.1.0 / docs refresh.
 *
 * Usage:  node research/probe.mjs <stage>
 *   stage = free | paid | all
 *
 * Cost discipline (per ~/pi-plugins/skills/pi-provider-plugin SKILL.md Phase 5):
 *   - every inference call uses max_tokens: 1 and a tiny prompt;
 *   - `free` stage runs on a zero-balance key (KEY1) and free-tier models only,
 *     so an *accepted* call still bills ¥0 and a rejected one bills nothing;
 *   - `paid` stage runs on KEY6 (authorised by the user for paid models);
 *   - limits are read from REJECTIONS (max_tokens: 99999999, oversized prompt),
 *     never from accepted generations.
 * Evidence is appended to research/evidence-2026-10-09.json; keys are never logged.
 */
import { appendFileSync, readFileSync } from "node:fs";

const EVIDENCE = new URL("./evidence-2026-10-09.json", import.meta.url).pathname;
const env = {};
for (const line of readFileSync(new URL("../secret.env", import.meta.url).pathname, "utf8").split("\n")) {
	const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
	if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const BASE = env.API.replace(/\/+$/, "");
const HOST = BASE.replace(/\/api\/paas\/v4$/, "");
const FREE = env.KEY1; // zero balance: only free-tier models answer
const PAID = env.KEY6; // has balance

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const records = [];

async function post(path, key, body, { label, timeoutMs = 60_000, raw = false } = {}) {
	const url = path.startsWith("http") ? path : `${BASE}${path}`;
	const rec = { label, url: url.replace(HOST, "…"), body: summarize(body) };
	try {
		const r = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await r.text();
		rec.status = r.status;
		try {
			const j = JSON.parse(text);
			rec.error = j.error ? { code: j.error.code, message: String(j.error.message).slice(0, 200) } : undefined;
			rec.model = j.model;
			rec.usage = j.usage;
			rec.finish = j.choices?.[0]?.finish_reason ?? j.choices?.[0]?.delta?.finish_reason;
			if (raw) rec.rawBody = text.slice(0, 1200);
		} catch {
			rec.rawBody = text.slice(0, 400);
		}
	} catch (e) {
		rec.status = "ERR";
		rec.error = { message: String(e).slice(0, 200) };
	}
	records.push(rec);
	console.log(
		`${label.padEnd(46)} ${String(rec.status).padEnd(4)} ${rec.error ? `code=${rec.error.code ?? "-"} ${rec.error.message ?? ""}` : ""}${rec.usage ? ` cached=${rec.usage.prompt_tokens_details?.cached_tokens ?? 0}/${rec.usage.prompt_tokens}` : ""}${rec.model && rec.model !== body.model ? ` →model=${rec.model}` : ""}`,
	);
	await sleep(700);
	return rec;
}

function summarize(body) {
	const b = { ...body };
	if (Array.isArray(b.messages)) {
		b.messages = b.messages.map((m) => ({
			role: m.role,
			len: typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length,
		}));
	}
	return b;
}

const tiny = { messages: [{ role: "user", content: "1" }], max_tokens: 1 };
const WEATHER_TOOL = {
	type: "function",
	function: {
		name: "get_weather",
		description: "Look up the weather for a city.",
		parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
	},
};

async function freeStage() {
	console.log("\n### FREE stage (KEY1, zero balance; free-tier models) ###");

	// 1. Listing (no inference).
	const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${PAID}` }, signal: AbortSignal.timeout(20_000) });
	const listing = await r.json();
	records.push({ label: "GET /models", status: r.status, ids: listing.data?.map((d) => d.id) });
	console.log(`GET /models -> ${r.status}: ${listing.data?.map((d) => d.id).join(", ")}`);

	// 2. thinking.type=disabled matrix on free models: 400/1210 = forced thinker, 200 = dynamic.
	for (const model of ["glm-4.7-flash", "glm-4.5-flash", "glm-4-flash-250414", "glm-4.1v-thinking-flash", "glm-4.6v-flash"]) {
		await post("/chat/completions", FREE, { model, ...tiny, thinking: { type: "disabled" } }, { label: `thinking:disabled ${model}` });
	}

	// 3. reasoning_effort boundary on free models (docs: GLM-5.2+ only).
	await post("/chat/completions", FREE, { model: "glm-4.7-flash", ...tiny, thinking: { type: "enabled" }, reasoning_effort: "low" }, { label: "effort=low glm-4.7-flash (expect reject)" });
	await post("/chat/completions", FREE, { model: "glm-4.5-flash", ...tiny, thinking: { type: "enabled" }, reasoning_effort: "max" }, { label: "effort=max glm-4.5-flash (expect reject)" });

	// 4. Output cap disclosed by a rejection (free: rejected requests are not billed).
	for (const model of ["glm-4.5-flash", "glm-4.7-flash"]) {
		await post("/chat/completions", FREE, { model, messages: [{ role: "user", content: "1" }], max_tokens: 99_999_999 }, { label: `max_tokens=99999999 ${model}` });
	}

	// 5. tool_stream on models the docs do NOT list as supporting it.
	for (const model of ["glm-4.5-flash", "glm-4-flash-250414"]) {
		await post("/chat/completions", FREE, { model, ...tiny, tools: [WEATHER_TOOL], tool_stream: true }, { label: `tool_stream ${model} (not in doc list)` });
	}

	// 6. strict tool schemas + response_format json_object (compat flags we pin).
	await post("/chat/completions", FREE, { model: "glm-4.5-flash", ...tiny, tools: [{ ...WEATHER_TOOL, function: { ...WEATHER_TOOL.function, strict: true } }] }, { label: "strict:true tool glm-4.5-flash" });
	await post("/chat/completions", FREE, { model: "glm-4.5-flash", messages: [{ role: "user", content: "Return JSON {\"ok\":true}" }], max_tokens: 20, response_format: { type: "json_object" } }, { label: "response_format json_object" });

	// 7. stream_options.include_usage — pi sends this on every streaming call.
	await post("/chat/completions", FREE, { model: "glm-4.5-flash", ...tiny, stream: true, stream_options: { include_usage: true } }, { label: "stream_options include_usage", raw: true });

	// 8. Fields pi never sends but a stale compat flag could: must stay rejected/ignored.
	await post("/chat/completions", FREE, { model: "glm-4.5-flash", ...tiny, store: false }, { label: "store:false (we declare supportsStore=false)" });
	await post("/chat/completions", FREE, { model: "glm-4.5-flash", ...tiny, prompt_cache_retention: "24h" }, { label: "prompt_cache_retention (declared false)" });
	await post("/chat/completions", FREE, { model: "glm-4.5-flash", ...tiny, prompt_cache_key: "pi-probe" }, { label: "prompt_cache_key (never sent by pi here)" });
	await post("/chat/completions", FREE, { model: "glm-4.5-flash", ...tiny, thinking: { type: "enabled", clear_thinking: false } }, { label: "clear_thinking:false (pi sends this)" });

	// 9. Implicit context cache: two identical long-prefix requests on a free model.
	const prefix = "Ты — ассистент. Ниже длинный стабильный префикс для проверки кэша.\n" + "Строка знания номер {i}: GLM поддерживает кэш контекста.\n".repeat(1).replace("{i}", "0");
	const long = Array.from({ length: 60 }, (_, i) => `${i}. Строка стабильного префикса для проверки имплицитного кэша контекста BigModel.`).join("\n");
	for (const attempt of [1, 2, 3]) {
		await post("/chat/completions", FREE, { model: "glm-4.5-flash", messages: [{ role: "system", content: long }, { role: "user", content: `question ${attempt}` }], max_tokens: 1, thinking: { type: "enabled", clear_thinking: false } }, { label: `cache probe #${attempt} (~${long.length} chars)` });
		await sleep(4000);
	}
	void prefix;

	// 10. Overflow: an oversized prompt must be REJECTED (free model → ¥0 even if not).
	const filler = Array.from({ length: 200_000 }, (_, i) => `token filler ${i} `).join("");
	await post("/chat/completions", FREE, { model: "glm-4.5-flash", messages: [{ role: "user", content: `${filler}\nSay ok` }], max_tokens: 1 }, { label: `overflow 200K tokens glm-4.5-flash (${(filler.length / 1e6).toFixed(1)}MB)`, timeoutMs: 120_000, raw: true });

	// 11. Sibling protocol surfaces (existence only; invalid model → free rejection).
	await post(`${HOST}/api/v1/responses`, PAID, { model: "definitely-not-a-model", input: "hi" }, { label: "POST /api/v1/responses (existence)" });
	await post(`${HOST}/api/anthropic/v1/messages`, PAID, { model: "definitely-not-a-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, { label: "POST /api/anthropic/v1/messages (existence)" });
}

async function paidStage() {
	console.log("\n### PAID stage (KEY6; max_tokens 1 unless noted) ###");

	// 12. thinking.type=disabled across the paid catalog: 1210 = forced thinker.
	const paidIds = ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5", "glm-4.7", "glm-4.7-flashx", "glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4.5-airx", "glm-4-flashx-250414", "glm-5v-turbo", "glm-4.6v", "glm-4.6v-flashx", "glm-4.5v", "glm-4.1v-thinking-flashx"];
	for (const model of paidIds) {
		await post("/chat/completions", PAID, { model, ...tiny, thinking: { type: "disabled" } }, { label: `thinking:disabled ${model}` });
	}

	// 13. reasoning_effort boundary on paid models.
	await post("/chat/completions", PAID, { model: "glm-5.1", ...tiny, thinking: { type: "enabled" }, reasoning_effort: "low" }, { label: "effort=low glm-5.1 (docs: unsupported)" });
	await post("/chat/completions", PAID, { model: "glm-4.7", ...tiny, thinking: { type: "enabled" }, reasoning_effort: "low" }, { label: "effort=low glm-4.7 (docs: unsupported)" });
	await post("/chat/completions", PAID, { model: "glm-5.2", ...tiny, thinking: { type: "enabled" }, reasoning_effort: "none" }, { label: "effort=none glm-5.2 (docs: gives up thinking)" });
	await post("/chat/completions", PAID, { model: "glm-5.3", ...tiny, thinking: { type: "enabled" }, reasoning_effort: "medium" }, { label: "effort=medium glm-5.3 (docs: only low/high/max)" });
	await post("/chat/completions", PAID, { model: "glm-5v-turbo", ...tiny, thinking: { type: "enabled" }, reasoning_effort: "low" }, { label: "effort=low glm-5v-turbo (docs: unsupported)" });

	// 14. Output cap from a rejection on a paid model.
	await post("/chat/completions", PAID, { model: "glm-4.5-air", messages: [{ role: "user", content: "1" }], max_tokens: 99_999_999, thinking: { type: "disabled" } }, { label: "max_tokens=99999999 glm-4.5-air" });

	// 15. Cache accounting on a paid model, through the numbers pi bills from.
	const long = Array.from({ length: 80 }, (_, i) => `${i}. Строка стабильного префикса для проверки имплицитного кэша контекста BigModel на платной модели.`).join("\n");
	for (const attempt of [1, 2]) {
		await post("/chat/completions", PAID, { model: "glm-5.3-flash", messages: [{ role: "system", content: long }, { role: "user", content: `q${attempt}` }], max_tokens: 1, thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "low" }, { label: `paid cache probe #${attempt} glm-5.3-flash` });
		await sleep(6000);
	}
}

const stage = process.argv[2] ?? "free";
if (stage === "free" || stage === "all") await freeStage();
if (stage === "paid" || stage === "all") await paidStage();

appendFileSync(EVIDENCE, JSON.stringify({ stage, at: new Date().toISOString(), records }, null, 1) + "\n---\n");
console.log(`\nevidence appended -> ${EVIDENCE} (${records.length} records)`);
