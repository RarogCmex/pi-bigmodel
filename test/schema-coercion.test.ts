/**
 * The coercion contract between `bigmodel_search`'s parameter schema and the
 * host validator — pinned against pi 1.5.0.
 *
 * pi 1.5.0 validates tool arguments with `@earendil-works/pi-schema` instead of
 * TypeBox's checker, and that release is the one that gives *plain JSON Schema*
 * tools the same coercion TypeBox-built tools always had: numeric strings to
 * numbers, `"true"` to `true`, a single value to a one-item array, `null` in an
 * optional property dropped. Our schema is plain JSON Schema (`as const`), so
 * the behaviour of 1.5.0 is what the model actually gets — and the error text it
 * sees is pi-schema's (`- count: expected number, got string`), not TypeBox's
 * (`must be number`).
 *
 * Two things are asserted here and nowhere else:
 *
 *  1. the schema holds no TypeBox-only feature (`Type.Refine`, `Type.BigInt`,
 *     `Type.Undefined`, codecs, `Format.Set()` formats) — 1.5.0 silently ignores
 *     those for tool arguments, so a schema relying on one would validate
 *     nothing while looking like it validates something;
 *  2. loose arguments a model really emits (`"5"` for a number, `null` for an
 *     optional field) are accepted and normalised, and the failure text a model
 *     sees on a bad call is pi-schema's.
 *
 * `@earendil-works/pi-schema` is linked by `scripts/link-pi.mjs` from the global
 * pi install, the same way the host's own packages are, so this suite runs
 * offline against the very validator the host will use.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { BIGMODEL_SEARCH_PARAMETERS, SEARCH_ENGINES, RECENCIES } from "../search.ts";

const validator = compile(BIGMODEL_SEARCH_PARAMETERS, { coerce: true });

/** Every path a schema can carry that 1.5.0 stops honouring for tool arguments. */
function typeBoxOnlyPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => typeBoxOnlyPaths(item, `${path}/${i}`));
  if (!value || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // TypeBox encodes Refine/BigInt/Undefined/codecs as custom `[Kind]` symbols,
    // which survive JSON serialisation as a string key only when a schema is
    // passed around as `kind`; registered formats show up in `format`. A schema
    // is allowed exactly the formats pi-schema knows (url included) — anything
    // else would silently stop being checked.
    if (key === "format" && typeof child === "string") {
      const known = ["url", "json-pointer-uri-fragment", "email", "uuid", "date-time", "date", "time", "ipv4", "ipv6"];
      if (!known.includes(child)) found.push(`${path}/format=${child}`);
    }
    if (key === "TypeBox" || key === "~kind" || key === "[Kind]") found.push(`${path}/${key}`);
    found.push(...typeBoxOnlyPaths(child, `${path}/${key}`));
  }
  return found;
}

describe("bigmodel_search schema — pi 1.5.0 validation contract", () => {
  it("carries no TypeBox-only feature that 1.5.0 would silently ignore", () => {
    assert.deepEqual(typeBoxOnlyPaths(BIGMODEL_SEARCH_PARAMETERS), []);
  });

  it("turns a numeric string into a number", () => {
    const result = validator.parse({ task: "GLM release notes", count: "5" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.value as { count?: unknown }).count, 5);
  });

  it("drops a null in an optional property instead of rejecting the call", () => {
    const result = validator.parse({ task: "GLM release notes", count: null });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal("count" in (result.value as object), false);
  });

  it("accepts the enums it advertises and nothing else", () => {
    for (const engine of SEARCH_ENGINES) {
      assert.equal(validator.parse({ task: "x", engine }).ok, true, engine);
    }
    for (const recency of RECENCIES) {
      assert.equal(validator.parse({ task: "x", recency }).ok, true, recency);
    }
    assert.equal(validator.parse({ task: "x", engine: "not-an-engine" }).ok, false);
    assert.equal(validator.parse({ task: "x", recency: "yesterday" }).ok, false);
  });

  it("reports a missing required field with pi-schema's message, not TypeBox's", () => {
    const result = validator.parse({});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map(({ path, keyword, message }) => ({ path, keyword, message })),
      [{ path: "/task", keyword: "required", message: "missing" }],
    );
  });

  it("reports a wrong type as 'expected number, got string'", () => {
    const result = validator.parse({ task: "x", count: "not-a-number" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map(({ path, keyword, message }) => ({ path, keyword, message })),
      [{ path: "/count", keyword: "type", message: "expected number, got string" }],
    );
  });

  it("keeps unknown keys — the schema is deliberately open, not strict", () => {
    // Documents the current contract rather than endorsing it: `additionalProperties`
    // is unset, so a model that invents `limit` is not rejected, and the tool's
    // execute() ignores it. If the schema ever tightens, this test must change on
    // purpose.
    const result = validator.parse({ task: "x", limit: "10" });
    assert.equal(result.ok, true);
  });
});
