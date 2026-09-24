/**
 * BigModel (Zhipu AI, open.bigmodel.cn) provider for pi.
 *
 * Registers `bigmodel` as a first-class pi-ai provider: a curated catalog of
 * the CN-endpoint GLM models (text + VLM, CNY-derived pricing, real thinking
 * semantics), `/login` support, an additive live-discovery overlay from
 * `GET /models`, and a readable message for the gateway's Chinese-only 401.
 *
 * The gateway is OpenAI-chat-completions compatible, so streaming/tool calls/
 * usage accounting are delegated to pi-ai's `openAICompletionsApi` with the
 * "zai" thinking format — the same protocol as the built-in z.ai provider,
 * live-verified on the CN endpoint (2026-09-24):
 *   - `thinking: {type: enabled|disabled}` (+`clear_thinking:false`) accepted;
 *   - `reasoning_effort` accepted by GLM-5.2 / GLM-5.3 family only;
 *   - `reasoning_content` deltas arrive in stream chunks;
 *   - `tool_stream: true` and `strict: true` tool schemas accepted;
 *   - GLM-5.3/GLM-4.7/GLM-4.5V/GLM-4.1V reject `thinking.type:"disabled"`
 *     with 400 code 1210 — their level maps hide "off".
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, a strict
// superset of the core one that re-exports `openAICompletionsApi`. This is
// the only pi-runtime-only import in the package; everything else lives in
// modules that plain Node can load, which is what makes them testable.
import { openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clarifyErrorMessage, normalizeOverflowError, shouldClarify } from "./errors.ts";
import { PROVIDER_ID } from "./models.ts";
import { buildBigModelProvider } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  // Two rewrites, both guarded to this provider and to error-stop assistants:
  //   1. overflow phrasing → `context_length_exceeded:` so auto-compaction runs
  //   2. the Chinese-only 401 wording → a readable auth message with the key link
  // Overflow is applied first so an overflow that also happens to look
  // auth-related still triggers compaction. The auth wording cannot trip pi's
  // retry or context-overflow classifiers.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== PROVIDER_ID) return;

    const overflow = normalizeOverflowError(message.errorMessage ?? "");
    if (overflow) return { message: { ...message, errorMessage: overflow } };

    if (!shouldClarify(message)) return;
    const errorMessage = clarifyErrorMessage(message.errorMessage ?? "");
    if (!errorMessage) return;
    return { message: { ...message, errorMessage } };
  });

  // Append a persistent helper entry so the auth fix doesn't disappear on
  // scroll. Interactive sessions only: appending an entry after the errored
  // assistant message would hide the error text from `pi -p` single-shot
  // output, whose last-message check expects the assistant message to remain
  // last. Guarded to error outcome + this provider + auth-looking text only;
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
    if (!shouldClarify(msg)) return;
    if (event.entries.some((e) => (e as { customType?: string }).customType === "bigmodel-auth-help"))
      return;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "bigmodel-auth-help",
          content:
            "BigModel (Zhipu AI): ключ недействителен, отозван или истёк. " +
            "Проверьте ключ и баланс: https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys — " +
            "затем выполните `/login bigmodel` или обновите `BIGMODEL_API_KEY`.",
          display: true,
        },
      ],
    };
  });

  pi.registerProvider(buildBigModelProvider(openAICompletionsApi()));
}
