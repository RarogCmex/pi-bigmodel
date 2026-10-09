/**
 * BigModel (Zhipu AI, open.bigmodel.cn) provider for pi.
 *
 * Registers `bigmodel` as a first-class pi-ai provider: a curated catalog of
 * the CN-endpoint GLM models (text + VLM, CNY-derived pricing, real thinking
 * semantics), `/login` support, an additive live-discovery overlay from
 * `GET /models`, and readable messages for the gateway's Chinese-only errors.
 *
 * Also registers `bigmodel_search`, a billed web-search sidecar (the
 * pi-alibaba-models pattern): `exposure: "codemode"` by default, `/bigmodel`
 * to configure, the same key as the provider. See search.ts.
 *
 * Two wire protocols are available and one is registered per process
 * (`BIGMODEL_PROTOCOL`, default `responses`):
 *   - `openai-responses` — `POST https://open.bigmodel.cn/api/v1/responses`.
 *     The default: it is the surface Zhipu is building out, the only one that
 *     documents `prompt_cache_key` (cluster routing for cache hits, which pi
 *     fills from the session id) and `previous_response_id`, and pi's adapter
 *     replays reasoning items for free. Its price: thinking cannot be switched
 *     off there (`reasoning.effort:"none"`, an undocumented
 *     `thinking:{type:"disabled"}` and `do_sample:false` were all accepted and
 *     all ignored — GLM-4.7 still spent ~100 reasoning tokens), so "off" is
 *     hidden from pi's picker instead of lying, and auth failures arrive as
 *     HTTP 200 with an in-band body (handled by `withGatewayErrorRemediation`);
 *   - `openai-completions` — `POST {base}/chat/completions`, the original
 *     surface, where `thinking:{type:"disabled"}` really zeroes
 *     reasoning_tokens. Choose it when turning thinking off matters more than
 *     cache routing.
 * Both were probed live on 2026-10-09; the evidence and the reasoning are in
 * `research/2026-10-09-refresh.md`.
 *
 * Streaming, tool calls and usage accounting are delegated to pi-ai's own
 * adapters — one per wire protocol, chosen at registration time (bottom of this
 * file). Live-verified on the CN endpoint 2026-09-24, re-verified 2026-10-09 on
 * pi 1.1.0 (raw evidence: `research/evidence-2026-10-09{,-responses}.json`).
 *
 * `openAIResponsesApi` — `POST /api/v1/responses`, the DEFAULT:
 *   - `input` items, `max_output_tokens`, `reasoning:{effort}`, output items and
 *     `response.*` stream events, all as pi's adapter emits them;
 *   - `prompt_cache_key` is documented here (cluster routing for cache hits) and
 *     pi fills it from the session id — the completions spec has no such field;
 *   - `reasoning` output items come back with `content[].type:"reasoning_text"`
 *     and `encrypted_content:null`; pi stores the item as the thinking block's
 *     signature and replays it verbatim, which the gateway accepts;
 *   - images travel as `image_url: "<data url>"` — a STRING. The completions-style
 *     `{url}` object is accepted with 200 and the image is silently dropped;
 *   - there is NO working off switch for thinking (`effort:"none"`, an
 *     undocumented `thinking:{type:"disabled"}` and `do_sample:false` are all
 *     accepted and all ignored), so "off" is hidden on this surface;
 *   - auth failures arrive as HTTP 200 with an in-band body, hence the fetch
 *     wrapper (see `withGatewayErrorRemediation`).
 *
 * `openAICompletionsApi` — `POST /api/paas/v4/chat/completions` (`BIGMODEL_PROTOCOL=completions`):
 *   - `thinking:{type:enabled|disabled}` (+`clear_thinking:false`), and
 *     `disabled` really zeroes `reasoning_tokens` — the reason this surface stays;
 *   - `reasoning_effort` is GLM-5.2 / GLM-5.3-family only, and GLM-5.3 enforces
 *     low|high|max (`medium` → 400/1210). The gateway silently ACCEPTS the field
 *     on models that ignore it, so acceptance proves nothing;
 *   - the GLM-5.3 family rejects `thinking.type:"disabled"` with 400/1210, so
 *     their level maps hide "off"; GLM-4.7 and GLM-4.5V stopped being forced
 *     thinkers (turn-level thinking), so "off" is offered for them here;
 *   - `reasoning_content` deltas arrive in stream chunks and pi replays them on
 *     the next turn — what the gateway's preserved-thinking mode requires;
 *   - `tool_stream: true` and `strict: true` tool schemas accepted.
 *
 * Shared by both surfaces: context overflow is 400 "Prompt exceeds max length"
 * (code 1261 / `context_length_exceeded`), and an empty balance arrives as HTTP
 * 429 (code 1113 / `insufficient_quota`), which pi would otherwise retry until its
 * budget runs out.
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, a strict
// superset of the core one that re-exports `openAICompletionsApi`. This is
// the only pi-runtime-only import in the package; everything else lives in
// modules that plain Node can load, which is what makes them testable.
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	clarifyErrorMessage,
	clarifyLimitErrorMessage,
	classifyLimitError,
	classifyRewritten,
	limitHelpEntryContent,
	normalizeOverflowError,
	shouldClarify,
} from "./errors.ts";
import { PROVIDER_ID, resolveProtocol } from "./models.ts";
import { buildBigModelProvider, withGatewayErrorRemediation } from "./provider.ts";
import {
	buildSearchTool,
	codemodeSectionText,
	fallbackAgentDir,
	loadSearchConfig,
	readStoredApiKey,
	resolveAskModel,
	resolveSearchEngine,
	resolveSearchExposure,
	saveSearchConfig,
	searchConfigPath,
	SEARCH_ENGINES,
	SEARCH_ENGINE_PRICES,
	SEARCH_EXPOSURES,
	SEARCH_EXPOSURE_LABELS,
	searchStatus,
} from "./search.ts";

export default function (pi: ExtensionAPI) {
  // Three rewrites, all guarded to this provider and to error-stop assistants,
  // each one reaching machinery pi already has:
  //   1. overflow phrasing → `context_length_exceeded:` so auto-compaction runs
  //   2. permanent 429s (no balance, spent quota, wrong plan) → an actionable
  //      message whose deny-list tag makes pi stop retrying
  //   3. the Chinese-only 401 wording → a readable auth message with the key link
  // Overflow goes first so an overflow that also looks auth-related still
  // compacts; the limit class goes before auth because its whole point is to
  // change pi's retry decision. Neither rewrite can trip the other classifier —
  // asserted in test/errors.test.ts against pi's real classifiers.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== PROVIDER_ID) return;

    const raw = message.errorMessage ?? "";

    const overflow = normalizeOverflowError(raw);
    if (overflow) return { message: { ...message, errorMessage: overflow } };

    const limit = clarifyLimitErrorMessage(raw);
    if (limit) return { message: { ...message, errorMessage: limit } };

    if (!shouldClarify(message)) return;
    const errorMessage = clarifyErrorMessage(raw);
    if (!errorMessage) return;
    return { message: { ...message, errorMessage } };
  });

  // Append a persistent helper entry so the auth fix doesn't disappear on
  // scroll. Interactive sessions only: appending an entry after the errored
  // assistant message would hide the error text from `pi -p` single-shot
  // output, whose last-message check expects the assistant message to remain
  // last. Guarded to error outcome + this provider + auth/limit-looking text;
  // deduped via customType so re-emits don't stack. Error outcomes are hard
  // exits — no `continue: true` here on purpose.
  pi.on("turn_end", (event, ctx) => {
    // ctx.hasUI is true only in TUI/RPC modes. In print/json mode appending an
    // entry after the errored assistant message hides the error text from
    // `pi -p` single-shot output (its last-message check expects the
    // assistant message to remain last), so the boundary entry is TUI-only.
    if (!ctx.hasUI) return;
    if (event.outcome !== "error") return;
    const msg = event.message as unknown as {
      role: string;
      stopReason?: string;
      provider?: string;
      errorMessage?: string;
    };
    if (msg.provider !== PROVIDER_ID) return;

    // By now `message_end` has already run and pi has replaced this message IN
    // PLACE (agent-session.js `_replaceMessageInPlace` deletes every key of the
    // stored object and assigns the rewrite over it), so `errorMessage` is our own
    // text, not the gateway's body. Classifying the body again therefore finds
    // nothing — that is how this hint became unreachable for the billing class
    // while the auth one survived only by quoting the original text. Read our own
    // marker first; the raw-body path stays as a fallback for any ordering pi
    // might introduce, and both are covered in test/entry.test.ts.
    const raw = msg.errorMessage ?? "";
    const rewritten = classifyRewritten(raw);
    const limitKind = rewritten?.type === "limit" ? rewritten.kind : classifyLimitError(raw)?.kind;
    const auth = rewritten?.type === "auth" || (!limitKind && shouldClarify(msg));
    if (!limitKind && !auth) return;

    const customType = limitKind ? "bigmodel-billing-help" : "bigmodel-auth-help";
    if (event.entries.some((e) => (e as { customType?: string }).customType === customType)) return;
    const content = limitKind
      ? limitHelpEntryContent(limitKind)
      : "BigModel (Zhipu AI): ключ недействителен, отозван или истёк. " +
        "Проверьте ключ и баланс: https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys — " +
        "затем выполните `/login bigmodel` или обновите `BIGMODEL_API_KEY`.";
    return {
      entries: [...event.entries, { type: "custom_message", customType, content, display: true }],
    };
  });

  // ── Search sidecar: bigmodel_search ────────────────────────────────────────
  // A billed tool on the platform's /web_search surface (plus a free-model
  // `ask` mode), exposed the pi-alibaba-models way: `codemode` by default —
  // callable from codemode scripts, never declared every turn. Config lives in
  // `{agentDir}/pi-bigmodel.json`; the agent dir mirrors pi's getAgentDir
  // (config.js:491 on 1.1.0 — PI_CODING_AGENT_DIR, then ~/.pi/agent) because a
  // runtime import of pi-coding-agent here would break the offline suite's
  // plain-Node import of this module.
  const agentDir = fallbackAgentDir();
  const searchCfg = loadSearchConfig(agentDir);
  const searchExposure = resolveSearchExposure(searchCfg);
  if (searchExposure !== "off") {
    pi.registerTool(buildSearchTool(searchCfg, { agentDir: () => agentDir }));
  }
  // A codemode-exposed tool is never declared, so the model would never learn
  // it exists. One system-prompt section fixes that — only while codemode is
  // the active exposure (direct/deferred declare themselves).
  if (searchExposure === "codemode") {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections = {
        ...event.systemPromptOptions.sections,
        bigmodel: codemodeSectionText(),
      };
    });
  }

  // ── Command: /bigmodel ────────────────────────────────────────────────
  pi.registerCommand("bigmodel", {
    description: "Поиск BigModel: сайдкар bigmodel_search (экспозиция, движок, модель для ask)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const dir = fallbackAgentDir();
      const cfg = loadSearchConfig(dir);
      const choice = await ctx.ui.select("BigModel:", [
        "Статус",
        `Поиск — экспозиция инструмента (сейчас: ${resolveSearchExposure(cfg)})`,
        `Поиск — движок по умолчанию (сейчас: ${resolveSearchEngine(cfg)}, ¥${SEARCH_ENGINE_PRICES[resolveSearchEngine(cfg)].toFixed(2)}/вызов)`,
        `Поиск — модель для action=ask (сейчас: ${resolveAskModel(cfg)})`,
      ]);
      if (!choice) return;

      if (choice === "Статус") {
        const s = searchStatus(cfg);
        const key = readStoredApiKey(dir) ?? process.env?.BIGMODEL_API_KEY;
        ctx.ui.notify(
          `bigmodel_search: экспозиция ${s.exposure}, движок ${s.engine} (¥${SEARCH_ENGINE_PRICES[s.engine].toFixed(2)}/вызов), ` +
            `модель ask ${s.askModel}. Ключ: ${key ? "есть" : "нет — /login bigmodel или BIGMODEL_API_KEY"}. ` +
            `Конфиг: ${searchConfigPath(dir)}`,
          "info",
        );
        return;
      }

      if (choice.includes("экспозиция")) {
        const current = resolveSearchExposure(cfg);
        const options = SEARCH_EXPOSURES.map((e) => `${current === e ? "• " : "  "}${SEARCH_EXPOSURE_LABELS[e]}`);
        const sel = await ctx.ui.select(`Экспозиция bigmodel_search (сейчас ${current}):`, options);
        if (!sel) return;
        const picked = SEARCH_EXPOSURES[options.indexOf(sel)] ?? current;
        saveSearchConfig(dir, { ...cfg, searchExposure: picked });
        const note = picked === "codemode" ? " Требует включённого codemode в pi; без codemode инструмент недостижим." : "";
        ctx.ui.notify(`Экспозиция bigmodel_search: ${picked}.${note} Перезагрузка…`, "info");
        await ctx.reload();
        return;
      }

      if (choice.includes("движок")) {
        const current = resolveSearchEngine(cfg);
        const options = SEARCH_ENGINES.map((e) => `${current === e ? "• " : "  "}${e} — ¥${SEARCH_ENGINE_PRICES[e].toFixed(2)}/вызов`);
        const sel = await ctx.ui.select(`Движок по умолчанию (сейчас ${current}):`, options);
        if (!sel) return;
        const picked = SEARCH_ENGINES[options.indexOf(sel)] ?? current;
        saveSearchConfig(dir, { ...cfg, searchEngine: picked });
        ctx.ui.notify(`Движок по умолчанию: ${picked}. Перезагрузка…`, "info");
        await ctx.reload();
        return;
      }

      if (choice.includes("модель")) {
        const entered = (await ctx.ui.input(
          `Модель для action=ask (пусто = ${resolveAskModel({})} — бесплатная; сейчас ${resolveAskModel(cfg)}):`,
        ))?.trim();
        if (entered === undefined) return;
        const next = { ...cfg };
        if (entered) next.askModel = entered;
        else delete next.askModel;
        saveSearchConfig(dir, next);
        ctx.ui.notify(
          `Модель ask: ${resolveAskModel(next)}${entered && !/flash/i.test(entered) ? " (не flash — тарифицируется как обычный ход модели поверх поискового вызова)" : ""}. Перезагрузка…`,
          "info",
        );
        await ctx.reload();
        return;
      }
    },
  });

  // One wire protocol per registration (see models.ts / provider.ts for the
  // trade-off): `BIGMODEL_PROTOCOL=responses` (default) or `completions`.
  const { api, requested, recognized } = resolveProtocol();
  const streams = api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
  pi.registerProvider(buildBigModelProvider(api, withGatewayErrorRemediation(streams)));

  // A typo'd protocol must not pass silently: `BIGMODEL_PROTOCOL=completio` would
  // otherwise land on Responses — the surface with no thinking off-switch — and
  // the user would debug a cost mystery instead of an env var. There is no notify
  // at registration time (`ui` lives on the handler context), so this rides the
  // first session start, and only where a notice cannot corrupt output.
  if (requested !== undefined && !recognized) {
    pi.on("session_start", (_event, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        `BigModel: BIGMODEL_PROTOCOL="${requested}" не распознано — зарегистрирован ${api}. ` +
          `Допустимые значения: responses, completions.`,
        "warning",
      );
    });
  }
}
