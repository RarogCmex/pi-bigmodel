/**
 * Live model discovery — the dynamic half of a semi-dynamic catalog.
 *
 * `GET https://open.bigmodel.cn/api/paas/v4/models` (live 2026-09-24, unchanged
 * 2026-10-09) returns an OpenAI-style `{"object":"list","data":[{"id":…}]}` with
 * *chat* ids only — the free flash models and all VLMs are absent from the
 * listing even though they answer both surfaces. The overlay is therefore
 * additive and unknowns-only: known catalog ids keep their curated CNY
 * prices/caps, new ids are appended with family-guessed thinking/vision/windows,
 * and a failed listing degrades to the baseline.
 *
 * The listing is read from the COMPLETIONS base even when the provider is
 * registered on the Responses surface, because that is the only endpoint that
 * publishes an id list for the standard API:
 *   - `GET /api/paas/v4/models` → 11 ids, OpenAI shape (used here);
 *   - `GET /api/v1/models` → exists, but returns 3 coding-plan-oriented entries
 *     (`glm-5.3`, `glm-5.3-flash`, `glm-5-turbo`) whose `id` field is EMPTY —
 *     the name lives in `slug`/`display_name` — so it cannot drive an overlay.
 *     Read 2026-10-09; it did corroborate two catalog facts (glm-5.3 reasoning
 *     levels are exactly low|high|max; glm-5.3-flash input modalities are
 *     text+image).
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID, type GatewayApi } from "./catalog.ts";
import { unknownModelToModel, type BigModelModel } from "./models.ts";

/** Payload of `GET /models` on open.bigmodel.cn. */
interface ModelsResponse {
	object?: string;
	data?: { id?: unknown }[];
}

/**
 * Non-chat models BigModel might someday list: embeddings/rerank, OCR,
 * image/video/audio generation, phone agents. Never wanted in an agent's
 * model picker.
 */
const EXCLUDED = /(embed|rerank|cogview|cogvideo|vidu|image|video|voice|tts|asr|realtime|ocr|autoglm|codegeex)/i;

/** Pull model ids out of a `/models` body. Pure so it can be tested without network. */
export function parseModelIds(payload: unknown): string[] {
	if (typeof payload !== "object" || payload === null) return [];
	const data = (payload as ModelsResponse).data;
	if (!Array.isArray(data)) return [];
	const ids: string[] = [];
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null) continue;
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== "string" || !id.trim()) continue;
		const trimmed = id.trim();
		if (EXCLUDED.test(trimmed)) continue;
		ids.push(trimmed);
	}
	return [...new Set(ids)];
}

/**
 * Overlay for discovered ids: catalog models stay in the baseline with full
 * metadata and pricing, so only ids the catalog does not know become overlay
 * entries (family-guessed thinking/vision/windows, zero cost).
 */
export function buildOverlay(
	ids: readonly string[],
	baseUrl: string,
	api: GatewayApi,
	known: ReadonlySet<string> = new Set(CATALOG_BY_ID.keys()),
): BigModelModel[] {
	return ids.filter((id) => !known.has(id) && !EXCLUDED.test(id)).map((id) => unknownModelToModel(id, baseUrl, api));
}

/** Resolve the bearer token pi's auth layer did not hand us (env-only setups). */
function resolveKey(context: RefreshModelsContext): string | undefined {
	const stored = context.credential;
	if (stored?.type === "api_key" && typeof stored.key === "string" && stored.key.trim()) {
		return stored.key.trim();
	}
	const fromEnv = typeof process !== "undefined" ? process.env?.BIGMODEL_API_KEY : undefined;
	return fromEnv?.trim() ? fromEnv.trim() : undefined;
}

/** Where the discovery targets point: the listing endpoint and the models' own base/api. */
export interface DiscoveryTargets {
	/** `GET {listingBaseUrl}/models` — the completions base, see the header. */
	listingBaseUrl: string;
	/** Base URL stamped on overlay models: the active surface's own base. */
	baseUrl: string;
	/** Wire protocol stamped on overlay models. */
	api: GatewayApi;
}

/**
 * `fetchModels` implementation. Never throws: returning `[]` leaves the
 * curated baseline (and any previously persisted overlay) untouched, so an
 * offline start or a dead key degrades to "static catalog" instead of
 * "broken provider".
 */
export async function fetchBigModelModels(
	targets: DiscoveryTargets,
	context: RefreshModelsContext,
	timeoutMs = 8_000,
): Promise<BigModelModel[]> {
	if (!context.allowNetwork || context.signal.aborted) return [];
	const key = resolveKey(context);
	if (!key) return [];

	// Honour pi's refresh signal, but also cap the wait so a hung gateway
	// cannot stall a session start that pi is awaiting.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	context.signal.addEventListener("abort", onAbort, { once: true });

	const { listingBaseUrl, baseUrl, api } = targets;
	try {
		// No `|| DEFAULT_BASE_URL` fallback: an unwired listingBaseUrl is a bug in
		// the caller and must fail visibly, not silently query another endpoint.
		const url = `${listingBaseUrl.replace(/\/+$/, "")}/models`;
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${key}` },
			signal: controller.signal,
		});
		if (!response.ok) return [];
		return buildOverlay(parseModelIds(await response.json()), baseUrl, api);
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
		context.signal.removeEventListener("abort", onAbort);
	}
}
