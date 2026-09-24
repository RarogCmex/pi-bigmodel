/**
 * Provider assembly.
 *
 * Split out from `index.ts` so it can be imported and tested under plain Node:
 * everything here resolves through pi-ai's core entrypoint. The one symbol
 * that does not — `openAICompletionsApi`, which pi's loader serves from the
 * compat entrypoint — is injected by `index.ts` instead of imported here.
 */

import {
	createProvider,
	envApiKeyAuth,
	type ApiKeyAuth,
	type Provider,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { fetchBigModelModels } from "./discovery.ts";
import { API_KEYS_URL } from "./errors.ts";

export { API_KEYS_URL } from "./errors.ts";
import { buildModels, cnyPerUsd, DEFAULT_BASE_URL, PROVIDER_ID, type GatewayApi } from "./models.ts";

export const API_KEY_AUTH_NAME = "BigModel (Zhipu AI) API key";
export const API_KEY_ENV_VAR = "BIGMODEL_API_KEY";
export const BASE_URL_ENV_VAR = "BIGMODEL_BASE_URL";

type EnvReader = (name: string) => string | undefined;

const processEnv: EnvReader = (name) =>
	typeof process !== "undefined" ? process.env?.[name] : undefined;

/** Endpoint override for proxies or the international api.z.ai mirror. */
export function resolveBaseUrl(env: EnvReader = processEnv): string {
	const trimmed = env(BASE_URL_ENV_VAR)?.trim().replace(/\/+$/, "");
	return trimmed ? trimmed : DEFAULT_BASE_URL;
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
 * Build the `bigmodel` provider.
 *
 * `models` is the curated baseline, always present and never
 * network-dependent. `fetchModels` layers live discovery on top: pi merges
 * the overlay per id, persists it through its own ModelsStore, and restores
 * it offline, so a new GLM release shows up without a catalog edit while a
 * dead key or no network degrades to the baseline.
 *
 * `api` is injected because pi's extension loader serves
 * `openAICompletionsApi` from the compat entrypoint — see index.ts.
 */
export function buildBigModelProvider(
	api: ProviderStreams,
	baseUrl: string = resolveBaseUrl(),
): Provider<GatewayApi> {
	return createProvider<GatewayApi>({
		id: PROVIDER_ID,
		name: "BigModel (Zhipu AI)",
		baseUrl,
		auth: { apiKey: bigmodelApiKeyAuth() },
		models: buildModels(baseUrl, cnyPerUsd(processEnv)),
		fetchModels: (context) => fetchBigModelModels(baseUrl, context),
		api,
	});
}
