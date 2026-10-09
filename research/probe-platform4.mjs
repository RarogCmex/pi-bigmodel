/** Follow-up probes #3: knowledge upload format, per-key scoping, chat+ws retry. */
import { appendFileSync, readFileSync } from "node:fs";

const EVIDENCE = new URL("./evidence-2026-10-09-platform.json", import.meta.url).pathname;
const env = {};
for (const line of readFileSync(new URL("../secret.env", import.meta.url).pathname, "utf8").split("\n")) {
	const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
	if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const BASE = env.API.replace(/\/+$/, "");
const HOST = BASE.replace(/\/api\/paas\/v4$/, "");
const MANAGED = "https://agent-api.bigmodel.cn/api/agent/managed";
const K3 = env.KEY3, PAID = env.KEY6;
const MAH = { "zai-version": "2026-05-26", "zai-beta": "managed-agents-2026-05-26" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const records = [];

async function call(label, url, key, { method = "GET", body, form, headers = {}, timeoutMs = 90_000 } = {}) {
	const rec = { label };
	try {
		const r = await fetch(url, {
			method,
			headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
			body: body ? JSON.stringify(body) : form,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await r.text();
		rec.status = r.status;
		rec.text = text.slice(0, 3000);
	} catch (e) {
		rec.status = "ERR";
		rec.error = String(e).slice(0, 200);
	}
	records.push(rec);
	console.log(`${label.padEnd(50)} ${String(rec.status).padEnd(4)} ${(rec.text ?? rec.error ?? "").slice(0, 140)}`);
	await sleep(900);
	return rec;
}

// 1. Managed paid session read by its OWN key (scoping check).
await call("managed: paid session events (KEY6)", `${MANAGED}/v1/sessions/sess_01a1219d-19f2-7f0c-89e3-8d2ca5d9c31a/events`, PAID, { headers: MAH });
await call("managed: paid session GET (KEY6)", `${MANAGED}/v1/sessions/sess_01a1219d-19f2-7f0c-89e3-8d2ca5d9c31a`, PAID, { headers: MAH });

// 2. Async KEY3 tasks read by KEY3.
await call("async-result KEY3 stream-task (KEY3)", `${BASE}/async-result/202610100059289eaf12897ff84528`, K3);
await call("async-result KEY3 enum-task (KEY3)", `${BASE}/async-result/2026101000593056f5aa655abe497e`, K3);

// 3. chat + web_search retry (1305 was transient).
await call("chat + web_search tool (retry 2)", `${BASE}/chat/completions`, PAID, {
	method: "POST", timeoutMs: 180_000,
	body: {
		model: "glm-4.7-flash",
		messages: [{ role: "user", content: "智谱AI最新发布的模型是什么？请根据搜索结果回答。" }],
		max_tokens: 200,
		tools: [{ type: "web_search", web_search: { enable: true, search_engine: "search_std", search_result: true, count: 3 } }],
	},
});

// 4. Knowledge upload: .txt, longer text, knowledge_type=1 (paragraph slicing).
const d1 = await call("knowledge create (txt)", `${HOST}/api/llm-application/open/knowledge`, PAID, {
	method: "POST",
	body: { embedding_id: 3, name: "pi-bigmodel-probe-txt", description: "temporary probe KB" },
});
const kbId = JSON.parse(d1.text ?? "{}").data?.id;
if (kbId) {
	const docForm = new FormData();
	const doc = [
		"# pi-bigmodel platform probe",
		"",
		"The async chat completions surface accepts glm-4.5-flash and glm-4.7-flash. Answers arrive via GET /api/paas/v4/async-result/{id} with task_status SUCCESS.",
		"",
		"The managed agents API lives on agent-api.bigmodel.cn and requires zai-beta headers. It bills model usage from the API balance; a zero-balance key produces session.error with retries_exhausted.",
		"",
		"The batch API supports a fixed legacy model list including glm-4-flash and embedding-2, but not the GLM-5.3 family.",
	].join("\n");
	docForm.append("files", new Blob([doc], { type: "text/plain" }), "probe.txt");
	docForm.append("knowledge_type", "1");
	await call("knowledge upload doc (.txt)", `${HOST}/api/llm-application/open/document/upload_document/${kbId}`, PAID, { method: "POST", form: docForm });
	let vectorized = false;
	for (let i = 0; i < 9 && !vectorized; i++) {
		await sleep(10_000);
		const r = await call(`knowledge doc list [try ${i + 1}]`, `${HOST}/api/llm-application/open/document?knowledge_id=${kbId}&page=1&size=10`, PAID);
		try {
			const d = JSON.parse(r.text).data.list?.[0];
			if (d) console.log(`   embedding_stat=${d.embedding_stat} words=${d.word_num} fail=${JSON.stringify(d.failInfo)}`);
			if (d.embedding_stat === 1) vectorized = true;
			if (d.embedding_stat === 2) break;
		} catch {}
	}
	const rr = await call("knowledge retrieve (.txt)", `${HOST}/api/llm-application/open/knowledge/retrieve`, PAID, {
		method: "POST",
		body: { query: "какая модель принимается async-поверхностью?", knowledge_ids: [kbId], top_k: 3 },
	});
	if (vectorized && JSON.parse(rr.text).data?.length) {
		await call("chat + retrieval tool (.txt)", `${BASE}/chat/completions`, PAID, {
			method: "POST",
			body: {
				model: "glm-4.7-flash",
				messages: [{ role: "user", content: "Какая модель принимается async-поверхностью? Ответь одной фразой." }],
				max_tokens: 100,
				tools: [{ type: "retrieval", retrieval: { knowledge_id: kbId, prompt_template: "Из документа\n\"\"\"\n{{knowledge}}\n\"\"\"\nответь на вопрос\n\"\"\"\n{{question}}\n\"\"\"" } }],
			},
		});
	}
	await call("knowledge delete (.txt)", `${HOST}/api/llm-application/open/knowledge/${kbId}`, PAID, { method: "DELETE" });
}

appendFileSync(EVIDENCE, JSON.stringify({ stage: "followup-paid-2", at: new Date().toISOString(), records }, null, 1) + "\n---\n");
console.log(`\nevidence appended (${records.length} records)`);
