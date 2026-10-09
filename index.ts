/**
 * BigModel (Zhipu AI, open.bigmodel.cn) provider for pi.
 *
 * Registers `bigmodel` as a first-class pi-ai provider: a curated catalog of
 * the CN-endpoint GLM models (text + VLM, CNY-derived pricing, real thinking
 * semantics), `/login` support, an additive live-discovery overlay from
 * `GET /models`, and readable messages for the gateway's Chinese-only errors.
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
 * The gateway is OpenAI-chat-completions compatible, so streaming/tool calls/
 * usage accounting are delegated to pi-ai's `openAICompletionsApi` with the
 * "zai" thinking format — the same protocol as the built-in z.ai provider.
 * Live-verified on the CN endpoint 2026-09-24 and re-verified 2026-10-09 on
 * pi 1.1.0 (raw evidence: `research/evidence-2026-10-09.json`):
 *   - `thinking: {type: enabled|disabled}` (+`clear_thinking:false`) accepted;
 *   - `reasoning_effort` is GLM-5.2 / GLM-5.3-family only, and GLM-5.3 enforces
 *     low|high|max (`medium` → 400 code 1210). The gateway silently ACCEPTS the
 *     field on models that ignore it, so acceptance proves nothing;
 *   - the GLM-5.3 family rejects `thinking.type:"disabled"` with 400/1210, so
 *     their level maps hide "off". GLM-4.7 and GLM-4.5V stopped being forced
 *     thinkers (turn-level thinking), so "off" is offered for them again;
 *   - `reasoning_content` deltas arrive in stream chunks and pi replays them on
 *     the next turn — exactly what the gateway's preserved-thinking mode
 *     (`clear_thinking:false`) requires;
 *   - `tool_stream: true` and `strict: true` tool schemas accepted;
 *   - context overflow is 400/1261 "Prompt exceeds max length";
 *   - an empty balance arrives as HTTP 429 code 1113, which pi would otherwise
 *     retry until its budget runs out.
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, a strict
// superset of the core one that re-exports `openAICompletionsApi`. This is
// the only pi-runtime-only import in the package; everything else lives in
// modules that plain Node can load, which is what makes them testable.
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	clarifyErrorMessage,
	clarifyLimitErrorMessage,
	classifyLimitError,
	limitHelpEntryContent,
	normalizeOverflowError,
	shouldClarify,
} from "./errors.ts";
import { PROVIDER_ID, resolveProtocol } from "./models.ts";
import { buildBigModelProvider, withGatewayErrorRemediation } from "./provider.ts";

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

    const limit = classifyLimitError(msg.errorMessage ?? "");
    const auth = !limit && shouldClarify(msg);
    if (!limit && !auth) return;

    const customType = limit ? "bigmodel-billing-help" : "bigmodel-auth-help";
    if (event.entries.some((e) => (e as { customType?: string }).customType === customType)) return;
    const content = limit
      ? limitHelpEntryContent(limit.kind)
      : "BigModel (Zhipu AI): ключ недействителен, отозван или истёк. " +
        "Проверьте ключ и баланс: https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys — " +
        "затем выполните `/login bigmodel` или обновите `BIGMODEL_API_KEY`.";
    return {
      entries: [...event.entries, { type: "custom_message", customType, content, display: true }],
    };
  });

  // One wire protocol per registration (see models.ts / provider.ts for the
  // trade-off): `BIGMODEL_PROTOCOL=responses` (default) or `completions`.
  const { api } = resolveProtocol();
  const streams = api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
  pi.registerProvider(buildBigModelProvider(api, withGatewayErrorRemediation(streams)));
}
