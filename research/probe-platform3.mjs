/** Follow-up probes #2: paid-stage loose ends. Budget: ≤ ¥0.02 extra. */
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
const K1 = env.KEY1, PAID = env.KEY6;
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
	console.log(`${label.padEnd(50)} ${String(rec.status).padEnd(4)} ${(rec.text ?? rec.error ?? "").slice(0, 160)}`);
	await sleep(900);
	return rec;
}

// 1. The archived PAID managed session — did the model turn finish, at what usage?
await call("managed: paid session events (archived)", `${MANAGED}/v1/sessions/sess_01a1219d-19f2-7f0c-89e3-8d2ca5d9c31a/events`, K1, { headers: MAH });

// 2. Retry chat + web_search with a 3-min timeout (¥0.01 search + ¥0 model).
await call("chat + web_search tool (retry, 180s)", `${BASE}/chat/completions`, PAID, {
	method: "POST",
	timeoutMs: 180_000,
	body: {
		model: "glm-4.7-flash",
		messages: [{ role: "user", content: "智谱AI最新发布的模型是什么？请根据搜索结果回答。" }],
		max_tokens: 200,
		tools: [{ type: "web_search", web_search: { enable: true, search_engine: "search_std", search_result: true, count: 3 } }],
	},
});

// 3. Async KEY3 tasks from followup #1 — final states.
await call("async-result KEY3 stream-task", `${BASE}/async-result/202610100059289eaf12897ff84528`, K1);
await call("async-result KEY3 enum-task", `${BASE}/async-result/2026101000593056f5aa655abe497e`, K1);

// 4. Knowledge e2e with document-status polling.
const d1 = await call("knowledge create (e2e)", `${HOST}/api/llm-application/open/knowledge`, PAID, {
	method: "POST",
	body: { embedding_id: 3, name: "pi-bigmodel-probe-e2e", description: "temporary probe KB" },
});
const kbId = d1.json?.id ?? JSON.parse(d1.text ?? "{}").data?.id;
if (kbId) {
	const docForm = new FormData();
	docForm.append("files", new Blob(["pi-bigmodel platform probe fact: the async surface accepts glm-4.5-flash. The managed agents API lives on agent-api.bigmodel.cn."], { type: "text/markdown" }), "probe.md");
	await call("knowledge upload doc (e2e)", `${HOST}/api/llm-application/open/document/upload_document/${kbId}`, PAID, { method: "POST", form: docForm });
	// poll the document list until the doc is not pending
	let vectorized = false;
	for (let i = 0; i < 12 && !vectorized; i++) {
		await sleep(10_000);
		const r = await call(`knowledge doc list [try ${i + 1}]`, `${HOST}/api/llm-application/open/document?knowledge_id=${kbId}&page=1&size=10`, PAID);
		const list = JSON.parse(r.text ?? "{}").data ?? [];
		const arr = Array.isArray(list) ? list : (list.get?.("list") ?? []);
		if (Array.isArray(arr) && arr.length) {
			const d = arr[0];
			console.log(`   doc status: ${JSON.stringify(d).slice(0, 300)}`);
			if (d.status === 1 || d.vectorizationStatus === 1 || d.state === "SUCCESS" || d.status === "SUCCESS") vectorized = true;
		}
	}
	const rr = await call("knowledge retrieve (e2e)", `${HOST}/api/llm-application/open/knowledge/retrieve`, PAID, {
		method: "POST",
		body: { query: "какая модель принимается async-поверхностью?", knowledge_ids: [kbId], top_k: 3 },
	});
	const data = JSON.parse(rr.text ?? "{}").data;
	if (Array.isArray(data) && data.length) {
		await call("chat + retrieval tool (e2e)", `${BASE}/chat/completions`, PAID, {
			method: "POST",
			body: {
				model: "glm-4.7-flash",
				messages: [{ role: "user", content: "Какая модель принимается async-поверхностью?" }],
				max_tokens: 100,
				tools: [{ type: "retrieval", retrieval: { knowledge_id: kbId, prompt_template: "Из документа\n\"\"\"\n{{knowledge}}\n\"\"\"\nответь на вопрос\n\"\"\"\n{{question}}\n\"\"\"" } }],
			},
		});
	}
	await call("knowledge delete (e2e)", `${HOST}/api/llm-application/open/knowledge/${kbId}`, PAID, { method: "DELETE" });
}

appendFileSync(EVIDENCE, JSON.stringify({ stage: "followup-paid", at: new Date().toISOString(), records }, null, 1) + "\n---\n");
console.log(`\nevidence appended (${records.length} records)`);
