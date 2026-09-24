import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import type { AuthContext, ProviderAuthInteraction, ProviderStreams } from "@earendil-works/pi-ai";
import { CATALOG } from "../catalog.ts";
import { DEFAULT_BASE_URL, PROVIDER_ID } from "../models.ts";
import {
	API_KEY_AUTH_NAME,
	API_KEYS_URL,
	API_KEY_ENV_VAR,
	BASE_URL_ENV_VAR,
	bigmodelApiKeyAuth,
	buildBigModelProvider,
	resolveBaseUrl,
} from "../provider.ts";
import { API_KEYS_URL as ERR_URL } from "../errors.ts";

const unused: ProviderStreams = {
  stream: () => {
    throw new Error("not used");
  },
  streamSimple: () => {
    throw new Error("not used");
  },
};

function authContext(env: Record<string, string>): AuthContext {
  return {
    env: async (name: string) => env[name],
    fileExists: async () => false,
  };
}

function interaction(entered: string): ProviderAuthInteraction & {
  notifications: { message: string; links?: readonly { url: string; label?: string }[] }[];
} {
  const notifications: { message: string; links?: readonly { url: string; label?: string }[] }[] = [];
  return {
    signal: new AbortController().signal,
    notifications,
    notify: (event) => {
      if (event.type === "info") notifications.push({ message: event.message, links: event.links });
    },
    prompt: async () => entered,
  };
}

describe("resolveBaseUrl", () => {
  const realEnv = process.env[BASE_URL_ENV_VAR];
  afterEach(() => {
    if (realEnv === undefined) delete process.env[BASE_URL_ENV_VAR];
    else process.env[BASE_URL_ENV_VAR] = realEnv;
  });

  test("defaults to the CN endpoint", () => {
    assert.equal(resolveBaseUrl(() => undefined), DEFAULT_BASE_URL);
    assert.equal(DEFAULT_BASE_URL, "https://open.bigmodel.cn/api/paas/v4");
  });

  test("honours an override, trimmed and without a trailing slash", () => {
    assert.equal(
      resolveBaseUrl(() => "  https://proxy.example.com/paas/v4///  "),
      "https://proxy.example.com/paas/v4",
    );
  });

  test("ignores a blank override", () => {
    assert.equal(resolveBaseUrl(() => "   "), DEFAULT_BASE_URL);
  });
});

describe("api key auth", () => {
  const auth = bigmodelApiKeyAuth();

  test("is named for the /login list", () => {
    assert.equal(auth.name, API_KEY_AUTH_NAME);
  });

  test("login points at the key page before prompting", async () => {
    const ui = interaction("deadbeefdeadbeefdeadbeefdeadbeef.cafebabecafebabe");
    const credential = await auth.login!(ui);
    assert.equal(credential.key, "deadbeefdeadbeefdeadbeefdeadbeef.cafebabecafebabe");
    assert.equal(ui.notifications.length, 1);
    assert.deepEqual(ui.notifications[0].links, [{ url: API_KEYS_URL, label: "BigModel API Keys" }]);
    assert.equal(ERR_URL, API_KEYS_URL);
  });

  test("login trims whitespace from a pasted key", async () => {
    const credential = await auth.login!(interaction("  abc.def\n"));
    assert.equal(credential.key, "abc.def");
  });

  test("login refuses an empty key", async () => {
    await assert.rejects(() => auth.login!(interaction("   \n")), /No API key entered/);
  });

  test("login warns about an unexpected shape but still saves it", async () => {
    const ui = interaction("some-other-format");
    const credential = await auth.login!(ui);
    assert.equal(credential.key, "some-other-format");
    assert.equal(ui.notifications.length, 2, "key page link plus the shape warning");
    assert.match(ui.notifications[1].message, /does not look like a BigModel key/);
  });

  test("resolve prefers the stored credential", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "key-from-env" }),
      credential: { type: "api_key", key: "key-stored" },
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "key-stored");
  });

  test("resolve falls back to the environment variable", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "key-from-env" }),
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "key-from-env");
    assert.equal(result?.source, API_KEY_ENV_VAR);
  });

  test("resolve trims an env key", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "  key-from-env\n" }),
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "key-from-env");
  });

  test("resolve reports unconfigured when neither source has a key", async () => {
    assert.equal(
      await auth.resolve({ ctx: authContext({}), signal: new AbortController().signal }),
      undefined,
    );
  });
});

describe("buildBigModelProvider", () => {
  test("registers the curated baseline under the bigmodel id", () => {
    const provider = buildBigModelProvider(unused);
    assert.equal(provider.id, PROVIDER_ID);
    assert.equal(provider.name, "BigModel (Zhipu AI)");
    assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
    const models = provider.getModels();
    assert.equal(models.length, CATALOG.length);
    for (const model of models) {
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.baseUrl, DEFAULT_BASE_URL);
    }
  });

  test("every catalog model is reachable by id", () => {
    const provider = buildBigModelProvider(unused);
    const ids = new Set(provider.getModels().map((m) => m.id));
    for (const entry of CATALOG) assert.ok(ids.has(entry.id), entry.id);
  });

  test("streams delegate to the injected api surface", () => {
    const provider = buildBigModelProvider(unused);
    assert.equal(typeof provider.stream, "function");
    assert.equal(typeof provider.streamSimple, "function");
    assert.equal(typeof provider.getModels, "function");
  });

  test("baseUrl override propagates to every model", () => {
    const provider = buildBigModelProvider(unused, "https://mirror.example.com/api/paas/v4");
    assert.equal(provider.baseUrl, "https://mirror.example.com/api/paas/v4");
    for (const model of provider.getModels()) {
      assert.equal(model.baseUrl, "https://mirror.example.com/api/paas/v4");
    }
  });
});
