# Changelog

Entries are read by pi 1.5.0 and shown under "Extension Updates" on the first fresh
launch after the package version grows. Headings must stay in the `## [x.y.z]` form —
pi's parser (`dist/utils/changelog.js`) only recognises a version triple.

## [0.7.1] — 2026-11-03

**Re-verified against pi 1.5.0** (2026-11-03): `tsc -p tsconfig.json` clean,
**208/208** tests green (7 of them new), offline boot unchanged. This release carries
no provider-behaviour change: it is the 1.5.0 host migration plus the first
`CHANGELOG.md`, which pi now reads by default from the package root (`pi.changelogPath`
is therefore not set).

- **Adopted — the tool-argument validation contract.** pi 1.5.0 validates tool
  arguments with `@earendil-works/pi-schema` and gives *plain JSON Schema* tools the
  coercion TypeBox-built tools always had. `bigmodel_search` declares its parameters as
  plain JSON Schema, so 1.5.0 is the first host where those coercion rules actually
  reach this tool. `test/schema-coercion.test.ts` pins the contract against the
  installed validator: a numeric string becomes a number, a `null` in an optional
  property is dropped, advertised enums are accepted and others are not, a missing
  `task` reports `- /task: missing`, a wrong type reports
  `- /count: expected number, got string` (pi-schema's text, not TypeBox's), and the
  schema carries no TypeBox-only feature (`Refine`/`BigInt`/`Undefined`/codecs/
  `Format.Set()` formats) that 1.5.0 would silently stop honouring. The last case also
  documents that the schema is deliberately open (`additionalProperties` unset).
- **`scripts/link-pi.mjs` now links `@earendil-works/pi-schema`** from the host
  install next to pi and pi-ai, so the new suite runs offline through `npm run check`
  against the exact validator the host will use.
- **Not adopted from 1.5.0, deliberately.** `Usage.cost.totalFromProvider` and
  `responseModel` are filled by the host runtime — this package declares `model.cost`
  for the catalog and never builds an `AssistantMessage`, so there is nothing to mark.
  The render-context `keyHint()`/`keyText()` pair needs a custom tool renderer, which
  this package does not register. `blocked` on `ctx.ui.custom()` needs an inline custom
  UI, and `/bigmodel` uses `ui.select`/`ui.input`/`ui.notify` only. `pi.exec()`
  `maxBuffer`/`truncated` is moot because `pi.exec()` is never called. GPT-6.1 Terra,
  the models.dev v2 catalog and the changed OpenAI/NVIDIA/Xiaomi defaults are host
  catalogs; this package's cards come from its own CNY-derived snapshot and the additive
  `GET /models` overlay. MCP OAuth client registration does not apply.
- **Fixed — the one real break in 1.5.0 for this package.** pi-ai 1.5.0 no longer
  re-exports TypeBox: pi maps an extension's `Type`/`Static`/`TSchema` import to the
  compat entry *plus the TypeBox it bundles*, which is a runtime mapping `tsc` does not
  see. `npm run typecheck` therefore failed with `TS2305: has no exported member 'Type'`
  in `test/wire-format.test.ts` and `test/responses.test.ts`. Both now import `Type`
  from `typebox` directly (the form the 1.5.0 extensions doc prescribes for new code),
  and `scripts/link-pi.mjs` links the host's bundled `typebox` next to pi and pi-ai so
  the suite resolves it outside pi. The test assertions are unchanged.
- **Checked and untouched.** The 1.5.0 tool-schema breaking change (TypeBox features
  outside JSON Schema no longer apply to tool arguments) is a no-op here — grep over
  `search.ts` and `index.ts` finds no `Refine`/`BigInt`/`Undefined`/codecs/`Format.Set()`.
- **Docs.** README's verification section gains the 1.5.0 run and the reasons each
  1.5.0 feature does or does not reach this package.

## [0.7.0] — 2026-10-23

Two ids gone and a number for each survivor: `glm-4.5`/`glm-4.5v` retired with the
price they were carrying, catalog re-read from the rate card.

## [0.6.0] — 2026-10-23

A misconfigured `BIGMODEL_BASE_URL` is now named and explained instead of surfacing as
an opaque failure; the gateway's own 403 is no longer read as an auth problem.

## [0.5.1] — 2026-10-22

Re-verified on pi 1.4.0. A foreign thinking block from another model is dropped rather
than folded into the transcript; no provider surface moved in 1.4.0 for this package.

## [0.5.0] — 2026-10-09

Bilingual messages: English by default, Russian via `PI_BIGMODEL_LANG`.

## [0.4.0] — 2026-10-09

`bigmodel_search` — the billed web-search sidecar, codemode-exposed, with the
search/ask split, engine selection and a spend note per call.

## [0.3.1] — 2026-10-09

Documentation corrections: the claims a review could not support were retracted.

## [0.3.0] — 2026-10-09

OpenAI Responses API became the default wire protocol; `BIGMODEL_PROTOCOL` keeps chat
completions available.

## [0.2.0] — 2026-10-09

Re-verified on pi 1.1.0 as the provider took its current catalog shape.

## [0.1.1] — 2026-10-06

Re-verified on pi 1.0.4; first shape of the provider, `/login` and the catalog.
