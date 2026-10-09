/** Follow-up probes for the platform survey — run after probe-platform.mjs free. */
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
const K1 = env.KEY1, K3 = env.KEY3, PAID = env.KEY6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const records = [];

async function call(label, url, key, { method = "GET", body, form, headers = {} } = {}) {
	const rec = { label };
	try {
		const r = await fetch(url, {
			method,
			headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
			body: body ? JSON.stringify(body) : form,
			signal: AbortSignal.timeout(60_000),
		});
		const text = await r.text();
		rec.status = r.status;
		rec.text = text.slice(0, 2600); // NO pruning — full bodies for the follow-ups
	} catch (e) {
		rec.status = "ERR";
		rec.error = String(e).slice(0, 200);
	}
	records.push(rec);
	console.log(`${label.padEnd(50)} ${String(rec.status).padEnd(4)} ${rec.text?.slice(0, 200) ?? rec.error}`);
	await sleep(900);
	return rec;
}

// 1. Full batch model list from the rejection (free).
const jsonl = JSON.stringify({ custom_id: "probe-001", method: "POST", url: "/v4/chat/completions", body: { model: "glm-4-flash-250414", messages: [{ role: "user", content: "Say OK" }], max_tokens: 8 } });
const form = new FormData();
form.append("purpose", "batch");
form.append("file", new Blob([jsonl], { type: "application/json" }), "probe-batch.jsonl");
await call("batch upload (full model list)", `${BASE}/files`, K3, { method: "POST", form });

// 2. Async tasks from the free run: did they finish?
await call("async-result task1 (run1, glm-4.5-flash)", `${BASE}/async-result/202610100056374a369f478b294d05`, K1);
await call("async-result task2 (stream:true)", `${BASE}/async-result/20261010005654ab1f249e34c74cd5`, K1);
await call("async-result task3 (run2)", `${BASE}/async-result/20261010005722dd102476a1894c3f`, K1);
await call("async-result task4 (glm-4.7-flash)", `${BASE}/async-result/20261010005655289d40e0c780451a`, K1);

// 3. Retry the rate-limited probes on KEY3.
await call("async stream:true (KEY3)", `${BASE}/async/chat/completions`, K3, {
	method: "POST",
	body: { model: "glm-4.5-flash", messages: [{ role: "user", content: "1" }], max_tokens: 1, stream: true },
});
await call("async glm-4.7-flash (KEY3)", `${BASE}/async/chat/completions`, K3, {
	method: "POST",
	body: { model: "glm-4.7-flash", messages: [{ role: "user", content: "1" }], max_tokens: 1 },
});

// 4. The archived managed session: what actually happened to the model turn?
await call("managed: archived session events", `${MANAGED}/v1/sessions/sess_01a12199-c028-76e4-a017-3b2ba0e51cb4/events`, K1, {
	headers: { "zai-version": "2026-05-26", "zai-beta": "managed-agents-2026-05-26" },
});

// 5. Free KBs: did vectorization complete without balance?
await call("knowledge retrieve KB run2", `${HOST}/api/llm-application/open/knowledge/retrieve`, K1, {
	method: "POST",
	body: { query: "platform probe", knowledge_ids: ["2108602882139078656"], top_k: 3 },
});
await call("knowledge retrieve KB run1", `${HOST}/api/llm-application/open/knowledge/retrieve`, K1, {
	method: "POST",
	body: { query: "platform probe", knowledge_ids: ["2108602635832774656"], top_k: 3 },
});

// 6. Document list of the free KB (vectorization status per document).
await call("knowledge doc list KB run2", `${HOST}/api/llm-application/open/document?knowledgeId=2108602882139078656&page=1&size=10`, K1);

// 7. Cleanup: delete both probe KBs (run1 stray + run2).
await call("knowledge delete KB run1", `${HOST}/api/llm-application/open/knowledge/2108602635832774656`, K1, { method: "DELETE" });
await call("knowledge delete KB run2", `${HOST}/api/llm-application/open/knowledge/2108602882139078656`, K1, { method: "DELETE" });

appendFileSync(EVIDENCE, JSON.stringify({ stage: "followup-free", at: new Date().toISOString(), records }, null, 1) + "\n---\n");
console.log(`\nevidence appended (${records.length} records)`);
void PAID;
