/**
 * i18n layer tests: placeholder parity between locales (a `ru` message missing
 * a substitution would leak a `{token}` into user output), locale detection
 * rules, and setLocale/tIn mechanics. Mirrors the pi-nvidia-plus i18n tests.
 */

import assert from "node:assert/strict";
import test, { afterEach, describe } from "node:test";
import { detectLocale, getLocale, LANG_ENV_VAR, MESSAGES, setLocale, t, tIn, type MessageKey } from "../i18n.ts";

function placeholders(template: string): Set<string> {
	return new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]));
}

describe("message catalog", () => {
	test("every message has both locales with identical placeholder sets", () => {
		for (const [key, entry] of Object.entries(MESSAGES) as Array<[MessageKey, { en: string; ru: string }]>) {
			assert.equal(typeof entry.en, "string", `${key}.en`);
			assert.equal(typeof entry.ru, "string", `${key}.ru`);
			assert.ok(entry.en.length > 0 && entry.ru.length > 0, `${key}: both locales non-empty`);
			const en = placeholders(entry.en);
			const ru = placeholders(entry.ru);
			assert.deepEqual([...ru].sort(), [...en].sort(), `${key}: placeholder mismatch en vs ru`);
		}
	});

	test("ASCII machine tags survive in both locales", () => {
		for (const locale of ["en", "ru"] as const) {
			assert.ok(tIn(locale, "authRewrite", { keysUrl: "x", original: "y" }).includes("[auth]"), `${locale} auth tag`);
		}
	});
});

describe("detectLocale", () => {
	test("explicit PI_BIGMODEL_LANG decides alone, and only ru* is Russian", () => {
		assert.equal(detectLocale({ [LANG_ENV_VAR]: "ru" }), "ru");
		assert.equal(detectLocale({ [LANG_ENV_VAR]: "ru_RU.UTF-8" }), "ru");
		assert.equal(detectLocale({ [LANG_ENV_VAR]: "RU" }), "ru");
		assert.equal(detectLocale({ [LANG_ENV_VAR]: "en", LANG: "ru_RU.UTF-8" }), "en");
		assert.equal(detectLocale({ [LANG_ENV_VAR]: "de", LANG: "ru_RU.UTF-8" }), "en");
	});

	test("then LC_ALL / LC_MESSAGES / LANG, C and POSIX skipped, default en", () => {
		assert.equal(detectLocale({ LC_ALL: "ru_RU.UTF-8" }), "ru");
		assert.equal(detectLocale({ LC_MESSAGES: "ru_RU.UTF-8", LANG: "en_US.UTF-8" }), "ru");
		assert.equal(detectLocale({ LANG: "ru_RU.UTF-8" }), "ru");
		assert.equal(detectLocale({ LANG: "en_US.UTF-8" }), "en");
		assert.equal(detectLocale({ LANG: "C" }), "en");
		assert.equal(detectLocale({ LANG: "POSIX" }), "en");
		assert.equal(detectLocale({}), "en");
	});
});

describe("t / tIn", () => {
	afterEach(() => setLocale("en")); // the offline suite's pinned locale

	test("substitutions fill every token; unknown tokens survive verbatim", () => {
		const out = tIn("en", "menuEngine", { engine: "search_pro", price: "0.03" });
		assert.ok(out.includes("search_pro"));
		assert.ok(out.includes("¥0.03"));
		assert.ok(!/\{engine\}|\{price\}/.test(out));
		assert.ok(tIn("en", "searchGeneric", { status: 500 }).includes("{codePart}"), "unset token stays visible");
	});

	test("setLocale drives t(); undefined returns to detection", () => {
		setLocale("ru");
		assert.ok(t("menuStatus") === "Статус");
		setLocale(undefined);
		// detection on a bare env (the test runner may set LANG) — just assert it
		// is one of the two and consistent with detectLocale.
		assert.equal(getLocale(), detectLocale());
	});
});
