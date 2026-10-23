/**
 * Search-links probe — 2026-10-23.
 *
 * Question: `bigmodel_search` advertises "заголовок/ссылка/сниппет", but on our
 * own queries `search_std` and `search_pro` came back with `link` (and `media`)
 * EMPTY — titles, snippets and dates populated, URLs absent. The docs' example
 * shows links. Two candidate explanations, and they call for different fixes:
 *
 *   a) the engine matters (`search_pro_sogou` / `search_pro_quark` come from a
 *      different index and may carry URLs);
 *   b) the query matters (our Chinese-tech / Russian queries may simply not be in
 *      the engine's indexed-with-link set), or `content_size` does.
 *
 * The tool's parser and formatter already survive the empty-link shape, so this
 * probe is about whether the *product* promise ("sources you can open") holds.
 *
 * Usage:  node research/probe-search-links.mjs
 * Cost:   one call per engine (¥0.01 std / ¥0.03 pro / ¥0.05 sogou|quark) plus
 *         one content_size=high repeat of the best engine, on KEY7 (the only
 *         funded key in `secret.env` as of 2026-10-23). Budget ceiling: ¥0.20.
 *         Keys are read from `secret.env` and never logged.
 *
 * Evidence is written to `research/evidence-2026-10-23-search-links.json`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const EVIDENCE = new URL("./evidence-2026-10-23-search-links.json", import.meta.url).pathname;
const env = {};
for (const line of readFileSync(new URL("../secret.env", import.meta.url).pathname, "utf8").split("\n")) {
	const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
	if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const BASE = env.API.replace(/\/+$/, "");
const KEY = env.KEY7;

/**
 * Three queries, chosen so the answer cannot be blamed on one language or one
 * topic: an English news-ish question, a Chinese one, and a Russian one.
 */
const QUERIES = [
	{ label: "en-news", q: "OpenAI latest model announcement" },
	{ label: "zh-tech", q: "智谱 GLM-5.3 发布" },
	{ label: "ru-tech", q: "новый релиз Node.js" },
];

/** What a usable "source" needs. `link` is the one under investigation. */
function fieldCoverage(results) {
	const count = (field) => results.filter((r) => typeof r?.[field] === "string" && r[field].trim()).length;
	return {
		results: results.length,
		withLink: count("link"),
		withMedia: count("media"),
		withTitle: count("title"),
		withContent: count("content"),
		withDate: count("publish_date"),
		withRefer: count("refer"),
		sampleKeys: results[0] ? Object.keys(results[0]).sort() : [],
	};
}

const evidence = { probedAt: new Date().toISOString(), key: "KEY7", calls: [], verdicts: [] };
let spent = 0;

async function search({ engine, query, contentSize = "medium" }) {
	const body = { search_engine: engine, search_query: query };
	if (contentSize === "high") body.content_size = "high";
	const response = await fetch(`${BASE}/web_search`, {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	const json = await response.json().catch(() => null);
	const fee = { search_std: 0.01, search_pro: 0.03, search_pro_sogou: 0.05, search_pro_quark: 0.05 }[engine] ?? 0;
	if (response.status === 200) spent += fee;
	const results = Array.isArray(json?.search_result) ? json.search_result : [];
	evidence.calls.push({ engine, query, contentSize, status: response.status, fee, coverage: fieldCoverage(results), body: json });
	return { status: response.status, json, results };
}

for (const query of QUERIES) {
	for (const engine of ["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"]) {
		const { status, results } = await search({ engine, query: query.q });
		const c = fieldCoverage(results);
		console.log(
			`${query.label.padEnd(8)} ${engine.padEnd(16)} ${String(status).padStart(3)}  ` +
				`n=${String(c.results).padStart(2)} link=${c.withLink} media=${c.withMedia} title=${c.withTitle} date=${c.withDate}`,
		);
	}
}

// If a link shows up anywhere, check whether the cheaper medium/high switch is
// what changes it — one call, only on an engine that already produced links.
const linked = evidence.calls.find((call) => call.coverage.withLink > 0);
if (linked) {
	const { results } = await search({ engine: linked.engine, query: linked.query, contentSize: "high" });
	console.log(`content_size=high on ${linked.engine}: link=${fieldCoverage(results).withLink}`);
} else {
	evidence.verdicts.push(
		"no engine returned a single non-empty `link` field on any of three queries in three languages",
	);
}

evidence.spentCny = Number(spent.toFixed(2));
writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
console.log(`\nspent ≈ ¥${spent.toFixed(2)}; evidence → ${EVIDENCE}`);
