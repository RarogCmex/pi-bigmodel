/**
 * Responses-API probe, round 3 — 2026-10-09. Zero inference cost by construction:
 *
 *  - catalog availability sweep: `max_output_tokens: 99999999` is rejected with
 *    400 invalid_request for a model that EXISTS and with 400 model_not_found for
 *    one that does not — both pre-inference, both free;
 *  - the known-good image control through chat completions (round 2's control was
 *    swallowed by a 1305 overload);
 *  - the 401 body shape on this surface, with a revoked key.
 *
 * `node research/probe-responses-3.mjs`
 */
import { appendFileSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
const EVIDENCE = new URL("./evidence-2026-10-09-responses.json", import.meta.url).pathname;
const env = {};
for (const line of readFileSync(new URL("../secret.env", import.meta.url).pathname, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const HOST = "https://open.bigmodel.cn";
const RESP = `${HOST}/api/v1/responses`;
const CHAT = `${env.API.replace(/\/+$/, "")}/chat/completions`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const records = [];
const { CATALOG } = await import("../catalog.ts");

function png() {
  const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(ty, "ascii"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(8).fill(Buffer.from([0, 0, 255])))])));
  return `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64")}`;
}

async function post(label, url, body, key, retries = 3) {
  for (let a = 1; ; a++) {
    let rec = { label };
    try {
      const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
      rec = { ...rec, status: r.status, code: j?.error?.code ?? j?.error?.type, message: String(j?.error?.message ?? "").slice(0, 120), usage: j?.usage, out: (j?.output ?? []).map((o) => o.type), text: JSON.stringify((j?.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("")).slice(0, 60) };
      if ((r.status === 429 || r.status === 500) && a <= retries) { await sleep(a * 4000); continue; }
    } catch (e) { rec = { ...rec, status: "ERR", message: String(e).slice(0, 120) }; }
    records.push(rec);
    console.log(`${label.padEnd(46)} ${String(rec.status).padEnd(4)} ${rec.code ?? ""} ${rec.message ?? ""}${rec.usage ? ` usage=${JSON.stringify(rec.usage).slice(0, 90)}` : ""}${rec.text ? ` text=${rec.text}` : ""}`);
    await sleep(500);
    return rec;
  }
}

console.log("### catalog availability on /api/v1/responses (free: every call is a rejection) ###");
const availability = {};
for (const entry of CATALOG) {
  const r = await post(entry.id, RESP, { model: entry.id, input: "hi", max_output_tokens: 99_999_999 }, env.KEY6);
  availability[entry.id] = r.code === "model_not_found" ? "ABSENT" : r.code ? `present (${r.code}: ${r.message})` : `? (${r.status})`;
}
for (const id of ["glm-5.4", "glm-4.5-air", "glm-4v-flash", "glm-4-long", "glm-5.3-flash"]) {
  if (availability[id]) continue;
  const r = await post(`${id} (extra)`, RESP, { model: id, input: "hi", max_output_tokens: 99_999_999 }, env.KEY6);
  availability[id] = r.code === "model_not_found" ? "ABSENT" : r.code ? `present (${r.code}: ${r.message})` : `? (${r.status})`;
}

console.log("\n### known-good image control through chat completions ###");
const data = png();
await post("control completions base64 png", CHAT, { model: "glm-4.6v-flash", messages: [{ role: "user", content: [{ type: "text", text: "What colour is this pixel? One word." }, { type: "image_url", image_url: { url: data } }] }], max_tokens: 8, thinking: { type: "disabled" } }, env.KEY1);
await post("responses base64 png again", RESP, { model: "glm-4.6v-flash", input: [{ role: "user", content: [{ type: "input_text", text: "What colour is this pixel? One word." }, { type: "input_image", image_url: data }] }], max_output_tokens: 16 }, env.KEY1);
await post("responses base64 png, image_url object", RESP, { model: "glm-4.6v-flash", input: [{ role: "user", content: [{ type: "input_text", text: "What colour?" }, { type: "input_image", image_url: { url: data } }] }], max_output_tokens: 16 }, env.KEY1);

console.log("\n### error shapes on this surface ###");
await post("401 with a revoked key", RESP, { model: "glm-4.5-flash", input: "hi", max_output_tokens: 16 }, env.KEY2);
await post("1113 with a zero-balance key", RESP, { model: "glm-4.5-air", input: "hi", max_output_tokens: 16 }, env.KEY1);

appendFileSync(EVIDENCE, "\n---\n" + JSON.stringify({ stage: "responses-round-3", at: new Date().toISOString(), availability, records }, null, 1) + "\n");
console.log("\n=== AVAILABILITY ===");
for (const [k, v] of Object.entries(availability)) console.log(`${k.padEnd(28)} ${v}`);
