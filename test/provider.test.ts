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
  withGatewayErrorRemediation,
} from "../provider.ts";
import { RESPONSES_BASE_URL } from "../models.ts";
import { API_KEYS_URL as ERR_URL } from "../errors.ts";

const CHAT = "openai-completions" as const;
const RESP = "openai-responses" as const;

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
    assert.equal(resolveBaseUrl(CHAT, () => undefined), DEFAULT_BASE_URL);
    assert.equal(DEFAULT_BASE_URL, "https://open.bigmodel.cn/api/paas/v4");
  });

  test("honours an override, trimmed and without a trailing slash", () => {
    assert.equal(
      resolveBaseUrl(CHAT, () => "  https://proxy.example.com/paas/v4///  "),
      "https://proxy.example.com/paas/v4",
    );
  });

  test("ignores a blank override", () => {
    assert.equal(resolveBaseUrl(CHAT, () => "   "), DEFAULT_BASE_URL);
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
    const provider = buildBigModelProvider(CHAT, unused);
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
    const provider = buildBigModelProvider(CHAT, unused);
    const ids = new Set(provider.getModels().map((m) => m.id));
    for (const entry of CATALOG) assert.ok(ids.has(entry.id), entry.id);
  });

  test("streams delegate to the injected api surface", () => {
    const provider = buildBigModelProvider(CHAT, unused);
    assert.equal(typeof provider.stream, "function");
    assert.equal(typeof provider.streamSimple, "function");
    assert.equal(typeof provider.getModels, "function");
  });

  test("baseUrl override propagates to every model", () => {
    const provider = buildBigModelProvider(CHAT, unused, () => undefined, "https://mirror.example.com/api/paas/v4");
    assert.equal(provider.baseUrl, "https://mirror.example.com/api/paas/v4");
    for (const model of provider.getModels()) {
      assert.equal(model.baseUrl, "https://mirror.example.com/api/paas/v4");
    }
  });
});

describe("protocol-aware registration", () => {
  test("the responses protocol registers every model on the /api/v1 base", () => {
    const provider = buildBigModelProvider(RESP, unused, () => undefined);
    assert.equal(provider.baseUrl, RESPONSES_BASE_URL);
    const models = provider.getModels();
    assert.equal(models.length, CATALOG.length);
    for (const model of models) {
      assert.equal(model.api, "openai-responses", model.id);
      assert.equal(model.baseUrl, RESPONSES_BASE_URL, model.id);
    }
  });

  test("the completions protocol still registers on /api/paas/v4", () => {
    const provider = buildBigModelProvider(CHAT, unused, () => undefined);
    assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
    for (const model of provider.getModels()) assert.equal(model.api, "openai-completions", model.id);
  });

  test("BIGMODEL_PROTOCOL selects the surface, and an override applies to whichever wins", () => {
    const responses = buildBigModelProvider(RESP, unused, (name) =>
      name === "BIGMODEL_PROTOCOL" ? "completions" : undefined,
    );
    // The protocol is decided by the caller (index.ts) — the provider builds
    // what it is told, so a mismatch here would be a wiring bug, not a config
    // one. What the env DOES control here is the base URL default.
    assert.equal(responses.baseUrl, RESPONSES_BASE_URL);

    const proxied = buildBigModelProvider(RESP, unused, (name) =>
      name === "BIGMODEL_BASE_URL" ? "https://proxy.example.com/v1/" : undefined,
    );
    assert.equal(proxied.baseUrl, "https://proxy.example.com/v1");
    for (const model of proxied.getModels()) assert.equal(model.baseUrl, "https://proxy.example.com/v1", model.id);
  });

  test("discovery reads the listing from the completions base even on responses", async () => {
    // GET /api/v1/models exists but returns three coding-plan entries with
    // EMPTY id fields, so the overlay must keep reading the paas/v4 listing
    // while stamping the active protocol on the models it builds.
    const provider = buildBigModelProvider(RESP, unused, () => undefined);
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ object: "list", data: [{ id: "glm-6.9" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    let published: any;
    try {
      await provider.refreshModels?.({
        allowNetwork: true,
        force: true,
        signal: new AbortController().signal,
        credential: { type: "api_key", key: "k" },
        publish: async (publication: unknown) => {
          published = publication;
          return true;
        },
      } as never);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(urls, [`${DEFAULT_BASE_URL}/models`], "the listing must come from the completions base");
    const overlay = published?.persist?.models ?? [];
    const discovered = overlay.find((m: { id: string }) => m.id === "glm-6.9");
    assert.ok(discovered, `glm-6.9 missing from the publication: ${JSON.stringify(overlay.map((m: { id: string }) => m.id))}`);
    assert.equal(discovered.api, "openai-responses", "overlay models must carry the active protocol");
    assert.equal(discovered.baseUrl, RESPONSES_BASE_URL);
  });
});

describe("withGatewayErrorRemediation", () => {
  const IN_BAND = '{"code":1000,"msg":"身份验证失败。","success":false}';

  function recordingApi(): { api: ProviderStreams; captured: () => unknown } {
    let capturedOptions: any;
    const api: ProviderStreams = {
      stream: () => {
        throw new Error("not used");
      },
      streamSimple: (_model, _context, options) => {
        capturedOptions = options;
        throw new Error("stop here");
      },
    };
    return { api, captured: () => capturedOptions };
  }

  test("injects a fetch that re-statuses an in-band 200 error", async () => {
    const { api, captured } = recordingApi();
    const wrapped = withGatewayErrorRemediation(api);
    assert.throws(() => wrapped.streamSimple({} as never, {} as never, {} as never), /stop here/);
    const injected = (captured() as { fetch: typeof fetch }).fetch;
    assert.equal(typeof injected, "function");

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(IN_BAND, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    try {
      const response = await injected("https://open.bigmodel.cn/api/v1/responses", {} as never);
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse(await response.text()), { error: { code: "1000", message: "身份验证失败。" } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("chains onto a caller-supplied fetch instead of replacing it", async () => {
    const { api, captured } = recordingApi();
    const wrapped = withGatewayErrorRemediation(api);
    const calls: string[] = [];
    const inner = (async (url: any) => {
      calls.push(String(url));
      return new Response("event: response.created\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    assert.throws(() => wrapped.streamSimple({} as never, {} as never, { fetch: inner } as never), /stop here/);
    const injected = (captured() as { fetch: typeof fetch }).fetch;
    const response = await injected("https://open.bigmodel.cn/api/v1/responses", {} as never);
    assert.deepEqual(calls, ["https://open.bigmodel.cn/api/v1/responses"]);
    assert.equal(response.status, 200, "a real stream is passed through");
  });

  test("does not double-wrap when applied twice", () => {
    const { api, captured } = recordingApi();
    const once = withGatewayErrorRemediation(api);
    const twice = withGatewayErrorRemediation(once);
    assert.throws(() => twice.streamSimple({} as never, {} as never, {} as never), /stop here/);
    const options = captured() as { fetch: unknown };
    const again = withGatewayErrorRemediation(api);
    assert.throws(() => again.streamSimple({} as never, {} as never, options as never), /stop here/);
    assert.equal((captured() as { fetch: unknown }).fetch, options.fetch, "the marked fetch was reused, not rewrapped");
  });
});
