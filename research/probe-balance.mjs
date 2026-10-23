/**
 * Balance probe — 2026-10-23.
 *
 * Question: can a plugin read a key's remaining balance (or remaining package
 * quota) from the gateway, so `pi` could show "you have ¥X left" instead of only
 * failing at 429/1113?
 *
 * Answer measured: no, not with an API key. The documented OpenAPI has no
 * account/billing path at all; the console API does have one, and it refuses
 * model API keys explicitly ("APIKey not allow access"), which is an allow-list
 * decision, not a balance one.
 *
 * Usage: node research/probe-balance.mjs
 * Cost:  ¥0 — every call here is rejected or metadata; no model inference.
 *        Writes research/evidence-2026-10-23-balance.json. Keys never logged.
 */
import { readFileSync, writeFileSync } from "node:fs";

const EVIDENCE = new URL("./evidence-2026-10-23-balance.json", import.meta.url).pathname;
const env = {};
for (const line of readFileSync(new URL("../secret.env", import.meta.url).pathname, "utf8").split("\n")) {
	const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
	if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const HOST = "https://open.bigmodel.cn";

/** Paths a console would plausibly use. Cheap to try: rejections are free. */
const CANDIDATES = [
	"/api/biz/customer/getUserAccountStatus",
	"/api/biz/customer/getUserAccount",
	"/api/biz/customer/getAccount",
	"/api/biz/customer/queryAccount",
	"/api/biz/customer/getAccountInfo",
	"/api/biz/customer/getBalance",
	"/api/biz/customer/queryBalance",
	"/api/biz/customer/account",
	"/api/biz/customer/account/getAccountBalance",
	"/api/biz/customer/getResourcePackageList",
	"/api/biz/customer/getUserResourcePackage",
	"/api/biz/customer/package/list",
	"/api/biz/resourcePackage/list",
	"/api/biz/account/getBalance",
	"/api/biz/customer/getCustomerInfo",
	"/api/finance/account/balance",
	"/api/paas/v4/account/balance",
];

const evidence = { probedAt: new Date().toISOString(), outcomes: {}, headerShapes: {}, headers: null, verdict: "" };

async function get(path, key, headerName = "Authorization", headerValue) {
	const headers = {};
	if (key) headers[headerName] = headerValue ?? `Bearer ${key}`;
	const response = await fetch(`${HOST}${path}`, { headers, signal: AbortSignal.timeout(25_000) });
	return { status: response.status, text: (await response.text()).slice(0, 200) };
}

/** Three outcomes mean three different things — that is the whole finding. */
function classify({ status, text }) {
	if (status === 403 && /APIKey not allow access/i.test(text)) return "EXISTS but this key class is not allowed";
	if (status === 200 && /"code":404/.test(text)) return "no such method under this router (in-band 404 with HTTP 200)";
	if (status === 200 && /"code":1001/.test(text)) return "exists, needs auth (in-band 1001)";
	if (status === 404) return "no such route";
	return `other: ${status}`;
}

for (const path of CANDIDATES) {
	const result = await get(path, env.KEY7);
	const verdict = classify(result);
	evidence.outcomes[path] = { ...result, verdict };
	if (verdict.startsWith("EXISTS")) console.log(`  ${path} → ${verdict}`);
}

// If something exists, try the auth shapes a console token might use.
const gated = Object.entries(evidence.outcomes).filter(([, v]) => v.verdict.startsWith("EXISTS"));
for (const [path] of gated) {
	for (const [name, value] of [
		["Authorization (bare key)", env.KEY7],
		["X-Api-Key", env.KEY7],
		["Authorization on a ZERO-BALANCE key", `Bearer ${env.KEY1}`],
	]) {
		const result = await get(path, env.KEY7, name.startsWith("X-") ? "X-Api-Key" : "Authorization", value);
		evidence.headerShapes[`${path} :: ${name}`] = { ...result, verdict: classify(result) };
	}
	const anon = await get(path, undefined);
	evidence.headerShapes[`${path} :: no auth`] = { ...anon, verdict: classify(anon) };
}

// Do ordinary responses leak a balance/quota header?
const chat = await fetch(`${HOST}/api/paas/v4/chat/completions`, {
	method: "POST",
	headers: { Authorization: `Bearer ${env.KEY7}`, "Content-Type": "application/json" },
	body: JSON.stringify({ model: "glm-4.5-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
	signal: AbortSignal.timeout(30_000),
});
evidence.headers = Object.fromEntries([...chat.headers.entries()].filter(([k]) => !/^vary$/.test(k)));

// A balance-shaped answer means DATA, not a word: the first version of this
// check matched `balance` inside the in-band 404's echoed request path
// ("接口不存在: /customer/getBalance") and reported a success that did not exist.
// So: 2xx, not an in-band error envelope, and an actual numeric amount field.
const inBandError = (text) => /"code":\s*(?:404|1001|1000)\b/.test(text);
const anyOpen = [...Object.values(evidence.outcomes), ...Object.values(evidence.headerShapes)].some(
	(r) => r.status === 200 && !inBandError(r.text) && /"(?:balance|amount|remain\w*|total\w*)"\s*:\s*"?[\d.]/i.test(r.text),
);
evidence.verdict = anyOpen
	? "something answered with balance-shaped data — see outcomes"
	: "NO balance API for model API keys: nothing returns balance data, and the one account endpoint that exists is closed to API keys (403 'APIKey not allow access'). Balance is console-only (https://bigmodel.cn/finance).";
writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.verdict}\nevidence → ${EVIDENCE}`);
