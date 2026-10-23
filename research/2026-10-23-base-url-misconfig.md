# `BIGMODEL_BASE_URL` misconfiguration — 2026-10-23

Why: the README claimed, without a measurement, that a completions base under the
Responses protocol "gives `…/api/paas/v4/responses` (404)". Adding a diagnosis for
it meant checking whether that is what the gateway actually does — and the first
probe (dummy key) showed it is **not** one single failure shape: authentication is
checked before routing, so a dead key answers 401/in-band-1000 for every path.

Re-probed with a real key (KEY1, zero balance — the relevant calls are rejections,
so nothing was billed; the only 2xx in this file is the in-band 401 envelope,
which carries no completion).

```bash
POST <url> -H "Authorization: Bearer $KEY1" -H 'content-type: application/json' \
  -d '{"model":"…","input":"hi","max_output_tokens":1}'
```

| URL | model | HTTP | body |
|---|---|---|---|
| `https://open.bigmodel.cn/api/paas/v4/responses` | `glm-4.7-flash` | 404 | `{"timestamp":"2026-10-23T15:58:44.222+00:00","status":404,"error":"Not Found","path":"/v4/responses"}` |
| `https://open.bigmodel.cn/api/v1/chat/completions` | `glm-4.7-flash` | 403 | `{"error":{"code":"model_access_denied","message":"No permission to access model: glm-4.7-flash","type":"model_access_denied"}}` |
| `https://open.bigmodel.cn/api/v1/responses/responses` | `glm-4.7-flash` | 404 | `404 page not found` |
| `https://open.bigmodel.cn/api/paas/v4/chat/completions/chat/completions` | `glm-4.7-flash` | 404 | `{"status":404,"error":"Not Found","path":"/v4/chat/completions/chat/completions"}` |

Two follow-ups, to make sure the 403 is about routing and not about that one model:

| URL | model | HTTP | body |
|---|---|---|---|
| `…/api/v1/chat/completions` | `definitely-not-a-model` | 403 | `model_access_denied` |
| `…/api/v1/chat/completions` | `glm-5.3` (an id `GET /api/v1/models` *does* list) | 403 | `model_access_denied` |

So `/api/v1` answers `model_access_denied` for **everything** on this key — the
completions API does not live there, but the symptom is a permission error, not a
404. Control, same key and same body on the real completions path:
`…/api/paas/v4/chat/completions` → `429 {"code":"1113","message":"余额不足或无可用资源包,请充值。"}`,
i.e. the path itself is fine and only the balance is empty.

Consequences taken into the code:

- the warning text claims that the call *fails*, not what the status is — the two
  directions fail differently, and inventing a uniform "404" would have been a
  second unmeasured claim in the same paragraph;
- the "full endpoint instead of a base" case **is** a 404 on both surfaces, so that
  message says 404;
- neither case is rewritten: the value is registered verbatim (a path-preserving
  proxy is indistinguishable from a mistake here — see the tests that assert
  `https://proxy.example.com/api/paas/v4` stays silent under completions).

Not measured, and therefore not claimed: whether a *Coding Plan* key gets past the
`/api/v1` 403 (that key class is a different product, `zai-coding-cn` in pi), and
what a funded key sees on `…/api/v1/chat/completions` — KEY1 cannot answer that,
because the rejection arrives before billing.

## Addendum: the live `pi -p` run found a second bug

Wiring the diagnosis into the response (`remediateMisdirectedRequest`) and running
`pi -p --model bigmodel/glm-4.7-flash` against a wrong base (`KEY1`, free model,
¥0) exposed a pre-existing false positive:

```
BigModel (Zhipu AI): [auth] ключ API недействителен … Исходная ошибка:
403: {"code":"403","message":"BigModel (Zhipu AI): [baseurl] запрос ушёл на … 403 …"}
```

The `403 model_access_denied` the edge produced was re-read as an auth failure:
`AUTH_RE` matches `40[13]`, and our own explanation of it was in the text. The
user would be told to check a working key while the base URL was the problem.

Two facts decided the fix:

1. **`startsWith(REWRITE_PREFIX)` is the wrong guard for the real flow.** pi
   wraps a non-2xx body as `bigmodel API error (403): {…}` *before* extensions
   see it, so a message of ours arrives prefixed and never starts with its own
   header. The existing idempotency guards (`clarifyErrorMessage`,
   `classifyLimitError`) are effective only on the `turn_end` path, where the
   message is our text unchanged.
2. **A tag survives the wrapping** — the same mechanism `[auth]` and
   `[billing 1113 …]` already use. `[baseurl]` now marks the diagnosis, and
   `isOwnDiagnosis()` (tag, or the header prefix) is honoured by `shouldClarify`,
   `clarifyErrorMessage` and `classifyLimitError`.

Scope note: a genuine `403 model_access_denied` on a *correct* base (key without
access to that model) still goes through the auth branch. That is an older
decision, not touched here — it needs its own measurement of what the gateway's
auth failures look like on the completions surface beyond 401/1000.
