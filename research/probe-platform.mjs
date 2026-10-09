/**
 * Platform-services live probe — 2026-10-09, after the v0.3.1 review.
 *
 * Scope: the five surfaces the README listed as "не исследовалось":
 *   async chat completions, Batch API, web search tools, knowledge base,
 *   managed agents. Question: is any of them usable *by a pi provider plugin*?
 *
 * Usage:  node research/probe-platform.mjs <stage>
 *   stage = free | paid | all
 *
 * Cost discipline (same as probe.mjs):
 *   - `free` stage runs on zero-balance keys (KEY1, rotating KEY3..KEY5 on 429):
 *     free-tier models bill ¥0 even when accepted; rejections bill nothing;
 *     per-call-billed services (web search) are expected to fail with 1113 —
 *     that failure IS the measurement.
 *   - `paid` stage runs on KEY6, authorised by the user, spend minimised:
 *     one search_std call (¥0.01), one web-search-in-chat on a free model
 *     (search ¥0.01 + model ¥0), one tiny knowledge doc (~¥0.00002 of
 *     embedding tokens) and, if needed, one minimal managed-agent turn on
 *     glm-5.3-flash (~¥0.001). Budget ceiling: ¥0.05.
 * Evidence is appended to research/evidence-2026-10-09-platform.json;
 * keys are never logged.
 */
import { appendFileSync, readFileSync } from "node:fs";

const EVIDENCE = new URL("./evidence-2026-10-09-platform.json", import.meta.url).pathname;
const env = {};
for (const line of readFileSync(new URL("../secret.env", import.meta.url).pathname, "utf8").split("\n")) {
	const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
	if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const BASE = env.API.replace(/\/+$/, ""); // …/api/paas/v4
const HOST = BASE.replace(/\/api\/paas\/v4$/, ""); // https://open.bigmodel.cn
const MANAGED = "https://agent-api.bigmodel.cn/api/agent/managed";
const FREE_KEYS = [env.KEY1, env.KEY3, env.KEY4, env.KEY5].filter(Boolean); // zero balance
const PAID = env.KEY6; // has balance

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const records = [];
let freeIdx = 0;
const nextFree = () => FREE_KEYS[freeIdx++ % FREE_KEYS.length];

async function call(label, url, key, { method = "GET", body, form, headers = {}, timeoutMs = 60_000, raw = false } = {}) {
	const rec = { label, url: url.replace(HOST, "…").replace(/^https:\/\/agent-api/, "…"), method };
	if (body) rec.body = body;
	try {
		const r = await fetch(url, {
			method,
			headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
			body: body ? JSON.stringify(body) : form,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await r.text();
		rec.status = r.status;
		try {
			const j = JSON.parse(text);
			rec.keys = Object.keys(j).slice(0, 14);
			rec.json = prune(j);
			if (raw) rec.rawBody = text.slice(0, 1500);
		} catch {
			rec.rawBody = text.slice(0, 300);
		}
	} catch (e) {
		rec.status = "ERR";
		rec.error = String(e).slice(0, 200);
	}
	records.push(rec);
	const brief = rec.json
		? JSON.stringify(rec.json).slice(0, 160)
		: (rec.rawBody ?? "").slice(0, 120);
	console.log(`${label.padEnd(52)} ${String(rec.status).padEnd(4)} ${brief}`);
	await sleep(800);
	return rec;
}

/** Keep evidence small: drop long strings/arrays, keep structure. */
function prune(v, depth = 0) {
	if (depth > 3) return "…";
	if (Array.isArray(v)) return v.length > 3 ? [...v.slice(0, 3).map((x) => prune(x, depth + 1)), `+${v.length - 3} more`] : v.map((x) => prune(x, depth + 1));
	if (v && typeof v === "object") {
		const out = {};
		for (const [k, val] of Object.entries(v)) {
			if (typeof val === "string" && val.length > 220) out[k] = `${val.slice(0, 200)}… (${val.length} chars)`;
			else out[k] = prune(val, depth + 1);
		}
		return out;
	}
	return v;
}

async function poll(label, url, key, { headers, isDone, tries = 12, intervalMs = 3000 } = {}) {
	for (let i = 0; i < tries; i++) {
		const rec = await call(`${label} [poll ${i + 1}]`, url, key, { headers });
		const j = rec.json;
		if (!j) return null;
		if (isDone(j)) return j;
		await sleep(intervalMs);
	}
	return null;
}

async function freeStage() {
	console.log("\n### FREE stage (zero-balance keys; rejections & free-tier models) ###");
	const key = nextFree();

	// --- A. Async chat completions --------------------------------------
	// A1: free model from the async enum (glm-4.5-flash), accepted → ¥0.
	const a1 = await call("async submit glm-4.5-flash", `${BASE}/async/chat/completions`, key, {
		method: "POST",
		body: { model: "glm-4.5-flash", messages: [{ role: "user", content: "Say OK" }], max_tokens: 8 },
	});
	const taskId = a1.json?.id ?? a1.json?.data?.id;
	if (taskId) {
		await poll("async-result", `${BASE}/async-result/${taskId}`, key, {
			isDone: (j) => j.task_status === "SUCCESS" || j.task_status === "FAIL" || j.status === "SUCCESS" || j.status === "FAIL",
			tries: 10, intervalMs: 2000,
		});
	}
	// A2: streaming in async — spec has no stream field; expect rejection.
	await call("async stream:true (expect reject)", `${BASE}/async/chat/completions`, key, {
		method: "POST",
		body: { model: "glm-4.5-flash", messages: [{ role: "user", content: "1" }], max_tokens: 1, stream: true },
	});
	// A3: model outside the async enum (glm-4.7-flash) — free rejection.
	await call("async glm-4.7-flash (not in enum)", `${BASE}/async/chat/completions`, key, {
		method: "POST",
		body: { model: "glm-4.7-flash", messages: [{ role: "user", content: "1" }], max_tokens: 1 },
	});

	// --- B. Batch API ----------------------------------------------------
	// B1: upload a 2-request jsonl on a free model (file upload is not billed).
	const jsonl = [
		{ custom_id: "probe-001", method: "POST", url: "/v4/chat/completions", body: { model: "glm-4-flash-250414", messages: [{ role: "user", content: "Say OK" }], max_tokens: 8 } },
		{ custom_id: "probe-002", method: "POST", url: "/v4/chat/completions", body: { model: "glm-4-flash-250414", messages: [{ role: "user", content: "Say YES" }], max_tokens: 8 } },
	].map((l) => JSON.stringify(l)).join("\n");
	const form = new FormData();
	form.append("purpose", "batch");
	form.append("file", new Blob([jsonl], { type: "application/json" }), "probe-batch.jsonl");
	const b1 = await call("files upload purpose=batch", `${BASE}/files`, key, { method: "POST", form });
	const fileId = b1.json?.id ?? b1.json?.data?.id ?? b1.json?.data?.get?.("id")?.[0];
	if (fileId) {
		const b2 = await call("batches create (glm-4-flash, 2 req)", `${BASE}/batches`, key, {
			method: "POST",
			body: { input_file_id: fileId, endpoint: "/v4/chat/completions", auto_delete_input_file: true, metadata: { probe: "pi-bigmodel-platform" } },
		});
		const batchId = b2.json?.id ?? b2.json?.data?.get("id")?.[0];
		if (batchId) {
			// Batch jobs may take minutes; poll a bounded window, keep the id for later.
			await poll("batch status", `${BASE}/batches/${batchId}`, key, {
				isDone: (j) => j.status === "completed" || j.status === "failed" || j.status === "expired" || j.status === "cancelled",
				tries: 20, intervalMs: 6000,
			});
			console.log(`  (batch_id for later re-check: ${batchId})`);
		}
	}

	// --- C. Web Search API (per-call billed → zero balance must 1113) ----
	await call("web_search search_std (zero balance)", `${BASE}/web_search`, key, {
		method: "POST",
		body: { search_query: "智谱AI GLM 最新模型", search_engine: "search_std", search_intent: true, count: 1, content_size: "medium" },
	});

	// --- D. Knowledge base -------------------------------------------------
	const d1 = await call("knowledge create (Embedding-2)", `${HOST}/api/llm-application/open/knowledge`, key, {
		method: "POST",
		body: { embedding_id: 3, name: "pi-bigmodel-probe", description: "temporary probe KB" },
	});
	const kbId = d1.json?.data?.id ?? d1.json?.id;
	if (kbId) {
		const docForm = new FormData();
		docForm.append("files", new Blob(["pi-bigmodel platform probe: async completions, batch, web search, knowledge, managed agents evaluated 2026-10-09."], { type: "text/markdown" }), "probe.md");
		await call("knowledge upload doc", `${HOST}/api/llm-application/open/document/upload_document/${kbId}`, key, { method: "POST", form: docForm });
		await call("knowledge retrieve (empty/waiting)", `${HOST}/api/llm-application/open/knowledge/retrieve`, key, {
			method: "POST",
			body: { query: "platform probe", knowledge_ids: [kbId], top_k: 3 },
		});
	}

	// --- E. Managed Agents (read + create on a zero-balance key) -----------
	const MAH = { "zai-version": "2026-05-26", "zai-beta": "managed-agents-2026-05-26" };
	await call("managed: list agents", `${MANAGED}/v1/agents`, key, { headers: MAH });
	const e1 = await call("managed: create agent (glm-5.3-flash)", `${MANAGED}/v1/agents`, key, {
		method: "POST",
		headers: MAH,
		body: { name: "pi-bigmodel-probe", model: "glm-5.3-flash", system: "You are a probe. Answer with one word." },
	});
	const agentId = e1.json?.id;
	if (agentId) {
		const e2 = await call("managed: create environment", `${MANAGED}/v1/environments`, key, {
			method: "POST",
			headers: MAH,
			body: { name: "pi-probe-env", config: { type: "cloud", networking: { type: "unrestricted" } } },
		});
		const envId = e2.json?.id;
		if (envId) {
			const e3 = await call("managed: create session", `${MANAGED}/v1/sessions`, key, {
				method: "POST",
				headers: MAH,
				body: { agent: agentId, environment_id: envId, title: "probe" },
			});
			const sessId = e3.json?.id;
			if (sessId) {
				await call("managed: send event (paid model, ¥0)", `${MANAGED}/v1/sessions/${sessId}/events`, key, {
					method: "POST",
					headers: MAH,
					body: { events: [{ type: "user.message", content: [{ type: "text", text: "Reply OK" }] }] },
				});
				await poll("managed: events", `${MANAGED}/v1/sessions/${sessId}/events`, key, {
					headers: MAH, isDone: (j) => (j.data ?? []).some((e) => e.type === "session.status_idle" || e.type === "session.error"), tries: 8, intervalMs: 2500,
				});
				await call("managed: archive session", `${MANAGED}/v1/sessions/${sessId}/archive`, key, { method: "POST", headers: MAH, body: {} });
			}
			await call("managed: delete environment", `${MANAGED}/v1/environments/${envId}`, key, { method: "DELETE", headers: MAH });
		}
		await call("managed: archive agent", `${MANAGED}/v1/agents/${agentId}/archive`, key, { method: "POST", headers: MAH, body: {} });
	}
}

async function paidStage() {
	console.log("\n### PAID stage (KEY6, budget ≤ ¥0.05) ###");

	// --- C. Web Search API: one search_std call (¥0.01) --------------------
	const c2 = await call("web_search search_std (paid)", `${BASE}/web_search`, PAID, {
		method: "POST",
		body: { search_query: "智谱AI GLM 最新模型", search_engine: "search_std", search_intent: true, count: 2, content_size: "medium" },
	});

	// --- C'. Web search inside chat completions: free model + ¥0.01 search -
	await call("chat + web_search tool (glm-4.7-flash)", `${BASE}/chat/completions`, PAID, {
		method: "POST",
		body: {
			model: "glm-4.7-flash",
			messages: [{ role: "user", content: "智谱AI最新发布的模型是什么？请根据搜索结果回答。" }],
			max_tokens: 200,
			tools: [{ type: "web_search", web_search: { enable: true, search_engine: "search_std", search_result: true, count: 3 } }],
		},
	});

	// --- D. Knowledge base end-to-end (~¥0.00002 embedding tokens) ---------
	const d1 = await call("knowledge create (paid key)", `${HOST}/api/llm-application/open/knowledge`, PAID, {
		method: "POST",
		body: { embedding_id: 3, name: "pi-bigmodel-probe-paid", description: "temporary probe KB" },
	});
	const kbId = d1.json?.data?.id ?? d1.json?.id;
	if (kbId) {
		const docForm = new FormData();
		docForm.append("files", new Blob(["pi-bigmodel platform probe fact: the async surface accepts glm-4.5-flash. The managed agents API lives on agent-api.bigmodel.cn."], { type: "text/markdown" }), "probe.md");
		const d2 = await call("knowledge upload doc (paid)", `${HOST}/api/llm-application/open/document/upload_document/${kbId}`, PAID, { method: "POST", form: docForm });
		void d2;
		// vectorization is async; wait, then retrieve
		let hit = null;
		for (let i = 0; i < 6 && !hit; i++) {
			await sleep(5000);
			const r = await call(`knowledge retrieve [try ${i + 1}]`, `${HOST}/api/llm-application/open/knowledge/retrieve`, PAID, {
				method: "POST",
				body: { query: "какая модель принимается async-поверхностью?", knowledge_ids: [kbId], top_k: 3 },
			});
			const list = Array.isArray(r.json?.data) ? r.json.data : [];
			if (list.length) hit = r.json;
		}
		if (hit) {
			// D3: the documented "retrieval tool" inside chat completions.
			await call("chat + retrieval tool (glm-4.7-flash)", `${BASE}/chat/completions`, PAID, {
				method: "POST",
				body: {
					model: "glm-4.7-flash",
					messages: [{ role: "user", content: "Какая модель принимается async-поверхностью?" }],
					max_tokens: 100,
					tools: [{ type: "retrieval", retrieval: { knowledge_id: kbId, prompt_template: "Из документа\n\"\"\"\n{{knowledge}}\n\"\"\"\nответь на вопрос\n\"\"\"\n{{question}}\n\"\"\"" } }],
				},
			});
		}
		await call("knowledge delete", `${HOST}/api/llm-application/open/knowledge/${kbId}`, PAID, { method: "DELETE" });
	}

	// --- E. Managed Agents: one minimal turn (~¥0.001 on glm-5.3-flash) ----
	const MAH = { "zai-version": "2026-05-26", "zai-beta": "managed-agents-2026-05-26" };
	const e1 = await call("managed: create agent (paid)", `${MANAGED}/v1/agents`, PAID, {
		method: "POST", headers: MAH,
		body: { name: "pi-bigmodel-probe-paid", model: "glm-5.3-flash", system: "Answer with exactly one word." },
	});
	const agentId = e1.json?.id;
	if (agentId) {
		const e2 = await call("managed: create environment (paid)", `${MANAGED}/v1/environments`, PAID, {
			method: "POST", headers: MAH,
			body: { name: "pi-probe-env-paid", config: { type: "cloud", networking: { type: "unrestricted" } } },
		});
		const envId = e2.json?.id;
		if (envId) {
			const e3 = await call("managed: create session (paid)", `${MANAGED}/v1/sessions`, PAID, {
				method: "POST", headers: MAH,
				body: { agent: agentId, environment_id: envId, title: "probe-paid" },
			});
			const sessId = e3.json?.id;
			if (sessId) {
				await call("managed: send event (paid)", `${MANAGED}/v1/sessions/${sessId}/events`, PAID, {
					method: "POST", headers: MAH,
					body: { events: [{ type: "user.message", content: [{ type: "text", text: "Reply with the single word OK" }] }] },
				});
				const done = await poll("managed: events (paid)", `${MANAGED}/v1/sessions/${sessId}/events`, PAID, {
					headers: MAH, isDone: (j) => (j.data ?? []).some((e) => e.type === "session.status_idle" || e.type === "session.error"), tries: 12, intervalMs: 3000,
				});
				if (done) {
					const s = await call("managed: session usage", `${MANAGED}/v1/sessions/${sessId}`, PAID, { headers: MAH });
					void s;
				}
				await call("managed: archive session (paid)", `${MANAGED}/v1/sessions/${sessId}/archive`, PAID, { method: "POST", headers: MAH, body: {} });
			}
			await call("managed: delete environment (paid)", `${MANAGED}/v1/environments/${envId}`, PAID, { method: "DELETE", headers: MAH });
		}
		await call("managed: archive agent (paid)", `${MANAGED}/v1/agents/${agentId}/archive`, PAID, { method: "POST", headers: MAH, body: {} });
	}
	void c2;
}

const stage = process.argv[2] ?? "free";
if (stage === "free" || stage === "all") await freeStage();
if (stage === "paid" || stage === "all") await paidStage();

appendFileSync(EVIDENCE, JSON.stringify({ stage, at: new Date().toISOString(), records }, null, 1) + "\n---\n");
console.log(`\nevidence appended -> ${EVIDENCE} (${records.length} records)`);
