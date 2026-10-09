# Platform services survey — 2026-10-09

Why: the README's "Протоколы и поверхности" table had one row marked **не исследовалось**
(async completions, Batch API, web search tools, knowledge base, managed agents).
This pass reads the docs, probes all five surfaces live and records a verdict for each:
usable *by this plugin* or not.

Raw evidence: `evidence-2026-10-09-platform.json` (stages `free`, `paid`,
`followup-free`, `followup-paid`, `followup-paid-2`, `followup-paid-3`,
`batch-e2e-free`, `batch-e2e-check`). Probes: `probe-platform.mjs` (+ follow-ups
`probe-platform2/3/4.mjs`). Keys from `secret.env`, never logged.

Cost ledger (KEY6): search_std ¥0.01 + web-search-in-chat ¥0.01 (model free) +
3 knowledge vectorizations ≈ ¥0.0002 + one managed-agent turn 1716/13 tokens on
glm-5.3-flash ≈ ¥0.0014 → **total ≈ ¥0.02**. Free keys spent ¥0 (free-tier
models, rejections, and a glm-4-flash batch that the platform runs for free).

Doc sources: `cn/guide/tools/web-search.md`, `cn/guide/tools/batch.md`,
`cn/guide/tools/knowledge/*` (retrieval, price), `cn/managed-agents/*` (overview,
quickstart, api-reference), `cn/guide/start/pricing.md`, `openapi/openapi.json`
(paths extracted: `/paas/v4/web_search`, `/paas/v4/async/chat/completions`,
`/paas/v4/async-result/{id}`, `/paas/v4/files`, `/paas/v4/batches`,
`/llm-application/open/knowledge*`, `/agent/managed/v1/*`).

## 1. Async chat completions — works, useless for pi

`POST /api/paas/v4/async/chat/completions` → task id, `GET /api/paas/v4/async-result/{id}`
→ full completion (`choices[0].message` incl. `reasoning_content`, `usage`).

Measured:

- free model (glm-4.5-flash, and glm-4.7-flash **outside the documented enum** —
  accepted silently, the repo's recurring pattern): 200, `task_status`
  PROCESSING → SUCCESS in ~12–60 s; ¥0 on a zero-balance key;
- `stream: true` is accepted and **ignored** (task completes normally, no SSE);
- task results are **scoped to the creating key's account**: KEY1 polling
  KEY3's task id → `400 {"code":1233,"message":"任务…不存在"}`; the FAQ documents
  no task expiry.

Verdict: **не пригодно.** pi-ai adapters are sync/SSE; a poll-based surface adds
latency and a second request for zero capability gain in an interactive agent.

## 2. Batch API — works end to end, wrong product for pi

`POST /paas/v4/files` (multipart, `purpose=batch`, `.jsonl`, `custom_id` ≥ 6 chars —
shorter ids are rejected 1210 with the min length in the message), `POST /paas/v4/batches`,
`GET /paas/v4/batches/{id}`, output via `GET /paas/v4/files/{id}/content`.

Measured:

- 2-request file on glm-4-flash: validating (~25 s) → in_progress → finalizing →
  **completed in ~4 min**, 2/2, output in OpenAI batch envelope
  (`{"response":{"status_code":200,"body":{…}},"custom_id":…}`);
- ran on a **zero-balance key** → glm-4-flash batch is free, as priced;
- the model list is **fixed and legacy** (from the 1210 rejection body, verbatim):
  glm-5.1, glm-5-turbo, glm-4, glm-4-0520, glm-4-plus, glm-4-long, glm-4-plus-0111,
  glm-4-air, glm-4-air-0111, glm-4-air-250414, glm-4-flash, glm-4-flashx-250414,
  glm-3-turbo, glm-4v, glm-4v-plus, glm-5v-turbo, glm-4v-plus-0111, cogview-3,
  cogview-3-plus, cogview-4-250304, embedding-2, embedding-3, cogvideox, cogvideox-2.
  None of the current flagship families (GLM-5.3/5.2/4.7/4.6) are batchable;
- 50% discount on batchable models (Embedding-2/3: ¥0.25/M).

Verdict: **не пригодно.** Batch is for offline bulk work; a coding agent is
interactive. Even if we wanted it, our catalog's models mostly aren't batchable.

## 3. Web search tools — works, wrong layer for a provider plugin

Two surfaces + MCP:

- `POST /paas/v4/web_search` (search_std/pro/pro_sogou/pro_quark; ¥0.01/0.03/0.05/0.05
  per call; `search_intent` required): 200 with structured `search_result[]`
  (title/link/content/media/publish_date/refer). Zero balance → 429/1113, i.e.
  per-call billing precedes everything.
- builtin chat tool `tools:[{type:"web_search", …}]` on completions: works on a
  **free model**; search results are injected (measured `prompt_tokens` 1863 vs 7
  without — injected text is billed as model input) and echoed as a top-level
  `web_search[]` array with sources; search itself billed ¥0.01;
- an MCP server exists (`/api/mcp-broker/proxy/web-search/mcp?Authorization=…`)
  for MCP-capable clients.

Verdict: **не пригодно как часть провайдера.** pi ships its own web search, and
pi-ai's tool model only carries `function` tools — we cannot declare a builtin
`web_search` tool on the user's behalf. A user who wants Zhipu search in pi can
add the MCP server themselves; that needs nothing from this plugin.

## 4. Knowledge base — works, with one sharp edge

REST under `/api/llm-application/open/`: create KB (`embedding_id` 3/11/12),
upload docs (multipart), retrieve (`recall_method` embedding/keyword/mixed,
`top_k`, optional rerank), delete. Storage ≤1 GB free, vectorization ¥0.5/M tokens.

Measured:

- KB create and doc upload succeed **even on a zero-balance key** (creation is
  free; the doc is stored);
- a `.md` blob upload failed vectorization silently at the document level:
  `embedding_stat: 2`, `failInfo: {embedding_code: 10001, embedding_msg: "知识不可用，
  文档损坏"}` — while retrieval kept returning `data: []` (200) as if the KB were
  merely empty. A `.txt` with `knowledge_type: 1` vectorized within seconds;
- retrieval returns scored chunks (`score`, full `metadata`: knowledge_id,
  doc_id, doc_name, doc_url, index);
- the chat-side `tools:[{type:"retrieval", retrieval:{knowledge_id}}]` tool:
  **an invalid knowledge_id degrades silently** — 200, `prompt_tokens` 7
  (nothing injected), no error field. A typo'd id yields a confident
  no-knowledge answer, not a failure.

Verdict: **не пригодно.** A cloud RAG store is a different product from a model
provider; pi agents read the repo locally. The silent-degradation edge (both in
vectorization and in the retrieval tool) is exactly the failure mode this repo's
catalog discipline exists to avoid promising away.

## 5. Managed Agents — works, and it is a competitor to pi, not a provider

`https://agent-api.bigmodel.cn/api/agent/managed`, headers `zai-version: 2026-05-26`
+ `zai-beta: managed-agents-2026-05-26`. Agents/Environments/Sessions/Events
(SSE), Files, Memory Stores, Vaults (credentials), Skills, cron Deployments.

Measured:

- full lifecycle on a **zero-balance key**: agent 201, environment 200, session
  200, event accepted 200 — then the model turn fails cleanly:
  `span.model_request_end {is_error: true, model_usage: 0…}` →
  `session.error {"message": "余额不足…", retry_status: exhausted}` →
  `session.status_idle`. The platform's own billing path is legible in events;
- one minimal turn on KEY6 (glm-5.3-flash, no tools, "Reply OK"):
  `agent.thinking` → `agent.message "OK"`, `span.model_request_end
  {is_error: false, input 1716 / output 13}` → idle. ≈ ¥0.0014. Note the
  **~1.7K-token platform system-prompt overhead per turn** and default
  `effort: "high"` on the agent config;
- resources are **per key/account**: KEY1 reading KEY6's session → 404
  `Session not found`;
- models: glm-5.3 / glm-5.3-flash / glm-5.3-flashx only; sandbox currently free;
  Coding Plan quota explicitly cannot pay for it.

Verdict: **не пригодно как поверхность провайдера** — it's not a wire protocol,
it's a hosted agent runtime (bash, files, memory, cron) that competes with the
host pi runs in. Potential future idea, out of scope here: a *separate* plugin
exposing a managed session as a delegated cloud subagent.

## Summary table

| Surface | Live result | Verdict for this plugin |
|---|---|---|
| async chat completions | 200, poll ~12–60 s, free models ¥0, `stream` ignored, per-key task scoping | not a wire protocol; skip |
| Batch API | e2e in ~4 min, legacy model list, glm-4-flash free | offline bulk; skip |
| web_search API + chat tool + MCP | all work; ¥0.01/call; injection billed as input | pi has its own search; function-tools only; skip |
| knowledge base | e2e works; silent vectorization failure on .md; invalid knowledge_id silently degrades | different product; skip |
| managed agents | full lifecycle works; per-turn ~1.7K-token platform overhead; clean billing events | hosted agent runtime = pi's competitor; skip |

Net: the "не исследовалось" row can now be closed. Nothing here changes the
plugin's provider surface; the two protocol rows (Responses/completions) remain
the only wire surfaces worth wiring.

## Addendum (same day, evening): the search sidecar shipped — and one more measurement

The verdict above ("web search — wrong layer for a *provider*") stands, but the
plugin now wires it as a **tool**, not as a provider surface: `bigmodel_search`
(`search.ts`), exposure `codemode` by default, `/bigmodel` to configure, the
same key as the provider. `action=search` → `POST /web_search`;
`action=ask` → chat completions on a free model with the builtin `web_search`
tool. The pi-alibaba-models `alibaba_tools` pattern, minus the sandbox and
image actions BigModel does not have.

Two zero-balance measurements made while wiring it (KEY1, both free):

1. `/web_search` answers **429/1113 before validating anything** — even an
   invalid engine is never reached on a broke key (on a funded key the engine
   check 400/1211 fires). Billing is strictly per call and upfront.
2. The in-chat builtin search on a zero-balance key does **not** fail and does
   **not** search: 200, an answer from parametric knowledge ("最新模型 —
   GLM-4", stale), no `web_search[]` array, no error. On a funded key the same
   call returns sources. The tool treats a missing array as a hard error, so an
   ungrounded answer can never be sold as a grounded one.

Also measured, worth recording for anyone reading the search results:
`search_std` and `search_pro` returned **empty `link`/`media` fields** on our
queries (titles, snippets and dates are populated; the docs' example shows
links). The parser and the text formatter handle both shapes; the fixtures
assert the empty-link one because that is what the gateway actually sent.

Cost of this addendum: ¥0 (everything above is rejections and free-tier ids).

## Redaction note (2026-10-09, before the first push)

`evidence-2026-10-09-platform.json` originally carried the CDN-signed document
URLs exactly as the gateway returned them (`q-ak=…`, `q-signature=…`). The
`q-ak` value matched a cloud-provider secret-id pattern and tripped GitHub's
push protection, so both signing parameters are replaced in-repo with
`REDACTED-CDN-KEY` / `REDACTED`. The signatures were short-lived anyway
(`q-sign-time` windows of ~10 h, long expired); nothing else in the file was
touched. The API keys themselves were never in the file — probes read them
from `secret.env` at run time and log only labels, statuses and bodies.
