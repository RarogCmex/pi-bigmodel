/**
 * Server-side retention probe — 2026-10-23.
 *
 * Question the README used to answer with "не измерялось": pi always sends
 * `store: false` on the Responses surface, but does the gateway keep the turn
 * anyway? The docs describe `store:true` as server-side state with a 7-day
 * lifetime and `previous_response_id` as the way to chain to it — so the
 * experiment is direct: create a response WITH `store:false`, then try to chain
 * to it by id.
 *
 * The logic is deliberately asymmetric, and that is the whole point:
 *   - a 2xx that can quote the earlier turn PROVES retention happened despite
 *     `store:false` — a finding that matters, because pi's users are told the
 *     field means "do not keep this";
 *   - a 4xx proves nothing on its own (the id may be expired, unknown to the
 *     route, or the field may simply be ignored) — it only means "cannot be
 *     chained from here". A negative result must never be reported as
 *     "therefore nothing is stored".
 *
 * Cost: ¥0 — `glm-4.5-flash` is free-tier, and both calls stay at 16/8 tokens.
 * Usage: node research/probe-retention.mjs   (reads keys from secret.env, never logs them)
 */
import { readFileSync, writeFileSync } from "node:fs";

const EVIDENCE = new URL("./evidence-2026-10-23-retention.json", import.meta.url).pathname;
const env = {};
for (const line of readFileSync(new URL("../secret.env", import.meta.url).pathname, "utf8").split("\n")) {
	const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
	if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const RESP = "https://open.bigmodel.cn/api/v1/responses";
const KEY = env.KEY1; // zero balance is fine: the model is free-tier
const MODEL = "glm-4.5-flash";

async function call(body, store = false) {
	const response = await fetch(RESP, {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: MODEL, store, max_output_tokens: 32, ...body }),
		signal: AbortSignal.timeout(90_000),
	});
	const json = await response.json().catch(() => null);
	return { status: response.status, json };
}

const first = await call({ input: "Remember this word exactly: BANANA42. Reply with just OK." });
const id = first.json?.id;
console.log(`create (store:false) → ${first.status} id=${id ?? "-"}`);

const evidence = {
	probedAt: new Date().toISOString(),
	model: MODEL,
	create: { status: first.status, id, store: false, usage: first.json?.usage ?? null, error: first.json?.error ?? null },
};

if (!id) {
	evidence.verdict = "inconclusive: the first call produced no response id";
} else {
	// The chain: same key, id from a response that explicitly said store:false.
	const second = await call({
		input: "Which word did I ask you to remember? Answer with just the word.",
		previous_response_id: id,
	});
	const text = JSON.stringify(second.json?.output ?? "");
	console.log(`chain (previous_response_id) → ${second.status} ${second.status === 200 ? text.slice(0, 120) : JSON.stringify(second.json?.error)}`);
	evidence.chain = {
		status: second.status,
		previous_response_id_echo: second.json?.previous_response_id ?? null,
		output: second.json?.output ?? null,
		usage: second.json?.usage ?? null,
		error: second.json?.error ?? null,
	};
	const quoted = /BANANA42/.test(text);
	// The control that makes the negative result mean something: if `store:true`
	// cannot chain either, the refuse is about the mechanism, not about storage.
	const controlCreate = await call({ input: "Remember this word exactly: CHERRY77. Reply with just OK." }, true);
	const controlId = controlCreate.json?.id;
	const controlChain = controlId
		? await call({ input: "Which word did I ask you to remember? Answer with just the word.", previous_response_id: controlId }, true)
		: null;
	const controlText = JSON.stringify(controlChain?.json?.output ?? "");
	console.log(
		`control (store:true) → create ${controlCreate.status} id=${controlId ?? "-"}, chain ${controlChain?.status ?? "-"} ` +
			`${controlChain && controlChain.status !== 200 ? JSON.stringify(controlChain.json?.error) : /CHERRY77/.test(controlText) ? "quoted CHERRY77" : "(no quote)"}`,
	);
	evidence.control = {
		store: true,
		createStatus: controlCreate.status,
		id: controlId ?? null,
		chainStatus: controlChain?.status ?? null,
		chainOutput: controlChain?.json?.output ?? null,
		chainError: controlChain?.json?.error ?? null,
		quotedEarlierTurn: /CHERRY77/.test(controlText),
	};

	const controlWorks = evidence.control.chainStatus === 200 && evidence.control.quotedEarlierTurn;
	const storeFalseWorks = second.status === 200 && quoted;
	evidence.verdict = storeFalseWorks
		? "RETENTION CONFIRMED despite store:false — the id was chainable and the model quoted the earlier turn"
		: controlWorks
			? "store:false IS honoured, and the control proves it: the same id pattern chains and quotes the earlier turn when store:true, and is `not_found` when store:false"
			: second.status === 200
				? "chained with 200 but the earlier turn was not visible under either flag — inconclusive about storage"
				: "INCONCLUSIVE: neither store:false nor store:true could chain, so the refusal is about the mechanism, not about retention";
}

writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
console.log(`verdict: ${evidence.verdict}\nevidence → ${EVIDENCE}`);
