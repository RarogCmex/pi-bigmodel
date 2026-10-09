/**
 * Provider assembly.
 *
 * Split out from `index.ts` so it can be imported and tested under plain Node:
 * everything here resolves through pi-ai's core entrypoint. The symbols that do
 * not — `openAICompletionsApi` / `openAIResponsesApi`, which pi's loader serves
 * from the compat entrypoint — are injected by `index.ts` instead of imported
 * here, so exactly one wire protocol is constructed per registration.
 */

import {
	createProvider,
	envApiKeyAuth,
	type ApiKeyAuth,
	type Provider,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { fetchBigModelModels } from "./discovery.ts";
import { API_KEYS_URL, remediateInBandResponse } from "./errors.ts";

export { API_KEYS_URL } from "./errors.ts";
import {
	buildModels,
	cnyPerUsd,
	BASE_URL_ENV_VAR,
	BASE_URL_BY_API,
	DEFAULT_BASE_URL,
	PROVIDER_ID,
	resolveBaseUrl,
	type GatewayApi,
} from "./models.ts";

export { BASE_URL_ENV_VAR, resolveBaseUrl } from "./models.ts";
export { PROTOCOL_ENV_VAR } from "./models.ts";

export const API_KEY_AUTH_NAME = "BigModel (Zhipu AI) API key";
export const API_KEY_ENV_VAR = "BIGMODEL_API_KEY";

type EnvReader = (name: string) => string | undefined;

const processEnv: EnvReader = (name) =>
	typeof process !== "undefined" ? process.env?.[name] : undefined;

/** Marker so wrapped fetches are not wrapped again (double registration / idempotence). */
const REMEDIATED = Symbol("bigmodel-in-band-remediation");

/**
 * Wrap a wire surface so every response passes `remediateInBandResponse`.
 *
 * The Responses surface answers authentication failures with **HTTP 200** and an
 * in-band `{"code":1000,"msg":"身份验证失败。","success":false}` body (measured
 * 2026-10-09 with a revoked key, a garbage key and no `Authorization` header).
 * pi streams, so it would parse that as an empty SSE response and surface
 * "stream ended before a terminal response event" — a message in pi's RETRYABLE
 * list, meaning a dead key burns the whole retry budget and the user is never
 * told the key is the problem.
 *
 * Injection composes with a caller-supplied fetch (pi may pass its own proxying
 * fetch): the wrapper chains onto it rather than replacing it. Everything that is
 * not an in-band error passes through byte-identical, and the body is read via
 * `clone()` so an unremediated stream stays intact.
 */
export function withGatewayErrorRemediation(api: ProviderStreams): ProviderStreams {
	const inject = (options: { fetch?: typeof fetch } | undefined): { fetch?: typeof fetch } => {
		const inner: typeof fetch | undefined = options?.fetch;
		if ((inner as { [REMEDIATED]?: boolean } | undefined)?.[REMEDIATED]) return options ?? {};
		const wrapped: typeof fetch = async (input, init) => remediateInBandResponse(await (inner ?? fetch)(input, init));
		(wrapped as unknown as { [REMEDIATED]: boolean })[REMEDIATED] = true;
		return { ...options, fetch: wrapped };
	};
	return {
		stream: (model, context, options) => api.stream(model, context, inject(options) as typeof options),
		streamSimple: (model, context, options) => api.streamSimple(model, context, inject(options) as typeof options),
	};
}

/**
 * Standard stored-key-then-env resolution, plus two BigModel-specific
 * touches: a link to the key page during `/login`, and whitespace trimming on
 * both paths (a key pasted with a trailing newline gets the same opaque 401
 * as a revoked one).
 */
export function bigmodelApiKeyAuth(): ApiKeyAuth {
	const base = envApiKeyAuth(API_KEY_AUTH_NAME, [API_KEY_ENV_VAR]);
	return {
		...base,

		async login(interaction) {
			interaction.signal.throwIfAborted();
			interaction.notify({
				type: "info",
				message: "Create a key on the BigModel (Zhipu AI) API Keys page:",
				links: [{ url: API_KEYS_URL, label: "BigModel API Keys" }],
			});
			const entered = await interaction.prompt({
				type: "secret",
				message: API_KEY_AUTH_NAME,
				placeholder: "xxxxxxxx.yyyyyyyy",
			});
			interaction.signal.throwIfAborted();
			const key = entered.trim();
			if (!key) throw new Error("No API key entered.");
			if (!/^[0-9a-f]{16,32}\.[0-9A-Za-z]{8,24}$/.test(key)) {
				// Accept it anyway — rejecting on shape would lock users out the
				// moment Zhipu changes its key format.
				interaction.notify({
					type: "info",
					message: "That does not look like a BigModel key (expected id.secret). Saving it regardless.",
				});
			}
			return { type: "api_key", key };
		},

		async resolve(input) {
			const resolved = await base.resolve(input);
			const key = resolved?.auth.apiKey?.trim();
			if (!resolved || !key) return undefined;
			return { ...resolved, auth: { ...resolved.auth, apiKey: key } };
		},
	};
}

/**
 * Build the `bigmodel` provider for ONE wire protocol.
 *
 * `protocol` decides the base URL, every model's `api` field and the compat
 * flags; `streams` must be the matching pi-ai adapter, wrapped in
 * `withGatewayErrorRemediation`. Only one surface is registered per process
 * (`BIGMODEL_PROTOCOL`, default `responses`) so the model picker shows 24 ids
 * rather than 48, and so a model can never end up pointing at an adapter that
 * was not constructed.
 *
 * `models` is the curated baseline, always present and never network-dependent.
 * `fetchModels` layers live discovery on top: pi merges the overlay per id,
 * persists it through its own ModelsStore, and restores it offline, so a new
 * GLM release shows up without a catalog edit while a dead key or no network
 * degrades to the baseline. The listing itself is always read from the
 * completions base — `GET /api/v1/models` on the Responses side returns three
 * coding-plan entries with empty `id` fields (see discovery.ts).
 */
export function buildBigModelProvider(
	protocol: GatewayApi,
	streams: ProviderStreams,
	env: EnvReader = processEnv,
	baseUrl: string = resolveBaseUrl(protocol, env),
): Provider<GatewayApi> {
	return createProvider<GatewayApi>({
		id: PROVIDER_ID,
		name: "BigModel (Zhipu AI)",
		baseUrl,
		auth: { apiKey: bigmodelApiKeyAuth() },
		models: buildModels(protocol, baseUrl, cnyPerUsd(env)),
		fetchModels: (context) =>
			fetchBigModelModels(
				{ listingBaseUrl: resolveBaseUrl("openai-completions", env), baseUrl, api: protocol },
				context,
			),
		api: streams,
	});
}

/** Both default endpoints, for tests and for the README's protocol table. */
export { BASE_URL_BY_API, DEFAULT_BASE_URL };
