/**
 * i18n layer: every user-facing string in two languages — English (default)
 * and Russian. Mirrors pi-nvidia-plus's `extensions/i18n.ts`.
 *
 * Locale resolution: `PI_BIGMODEL_LANG` has priority and, when set, decides
 * alone; then the first set of `LC_ALL` / `LC_MESSAGES` / `LANG` (`C`/`POSIX`
 * count as unset); anything not starting with `ru` is English. A fresh
 * install with a plain env therefore gets English — Russian is opt-in.
 *
 * Leaf module, no dependencies: `setLocale` for tests and live switching,
 * `tIn` for an explicit locale. `{name}` substitutions; the substitution sets
 * of both locales must match (asserted in test/i18n.test.ts).
 *
 * Not translated: ASCII machine tags the code reads back (`[billing 1113
 * balance]`, `[auth]`, the `context_length_exceeded:` prefix), tool metadata
 * and tool *result* text (model-facing — the codemode script reads
 * `structuredContent` anyway), debug labels, proper names.
 */

export type Locale = "en" | "ru";

export const LANG_ENV_VAR = "PI_BIGMODEL_LANG";

export const MESSAGES = {
	// ── Provider error rewrites (errors.ts) ──────────────────────────────
	authRewrite: {
		en: "BigModel (Zhipu AI): [auth] the API key is invalid, revoked or expired (or was not sent). " +
			"Check the key: {keysUrl} — then run `/login bigmodel` or update `BIGMODEL_API_KEY`. Original error: {original}",
		ru: "BigModel (Zhipu AI): [auth] ключ API недействителен, отозван или истёк (либо не передан). " +
			"Проверьте ключ: {keysUrl} — затем выполните `/login bigmodel` или обновите `BIGMODEL_API_KEY`. Исходная ошибка: {original}",
	},
	limitAdviceBalance: {
		en: "the account is out of funds and has no resource packages. Top up the balance or attach a package: " +
			"{billingUrl}. The free models (glm-4.7-flash, glm-4.5-flash, glm-4-flash-250414, glm-4.6v-flash, " +
			"glm-4.1v-thinking-flash) keep working with no balance.",
		ru: "на аккаунте закончились деньги и нет ресурсных пакетов. Пополните баланс или подключите пакет: " +
			"{billingUrl}. Бесплатные модели (glm-4.7-flash, glm-4.5-flash, glm-4-flash-250414, glm-4.6v-flash, " +
			"glm-4.1v-thinking-flash) продолжают работать и без баланса.",
	},
	limitAdviceQuota: {
		en: "the usage limit was reached (it resets at the time the server reports). Retrying before the reset " +
			"will not help; if necessary switch to a cheaper model or another key.",
		ru: "достигнут предел использования (лимит сбросится в указанное сервером время). Повторные запросы до сброса " +
			"не помогут; при необходимости возьмите модель дешевле или другой ключ.",
	},
	limitAdvicePlan: {
		en: "the key or subscription does not include this model. GLM Coding Plan keys work on the endpoint " +
			"/api/coding/paas/v4 (in pi that is the built-in zai-coding-cn provider), while this plugin uses the " +
			"standard pay-as-you-go /api/paas/v4: {codingPlanUrl}.",
		ru: "ключ или подписка не дают доступа к этой модели. Ключи GLM Coding Plan работают на эндпоинте " +
			"/api/coding/paas/v4 (в pi это встроенный провайдер zai-coding-cn), а этот плагин использует стандартный " +
			"/api/paas/v4 с оплатой по факту: {codingPlanUrl}.",
	},
	limitRewrite: {
		en: "BigModel (Zhipu AI): {advice} {tag} Original error: {original}",
		ru: "BigModel (Zhipu AI): {advice} {tag} Исходная ошибка: {original}",
	},
	limitHelpEntry: {
		en: "BigModel (Zhipu AI): the request was rejected for a reason other than load; retrying will not help. {suffix}",
		ru: "BigModel (Zhipu AI): запрос отклонён не из-за нагрузки, повторные попытки не помогут. {suffix}",
	},
	limitHelpSuffixBilling: {
		en: "Balance and limits: {billingUrl} — key: {keysUrl}",
		ru: "Баланс и лимиты: {billingUrl} — ключ: {keysUrl}",
	},
	limitHelpSuffixPlan: {
		en: "Coding Plan keys belong to a different endpoint: {codingPlanUrl}",
		ru: "Ключи Coding Plan относятся к другому эндпоинту: {codingPlanUrl}",
	},

	// ── index.ts: persistent hints and the protocol warning ──────────────
	authHelpEntry: {
		en: "BigModel (Zhipu AI): the API key is invalid, revoked or expired. Check the key and balance: " +
			"{keysUrl} — then run `/login bigmodel` or update `BIGMODEL_API_KEY`.",
		ru: "BigModel (Zhipu AI): ключ недействителен, отозван или истёк. Проверьте ключ и баланс: " +
			"{keysUrl} — затем выполните `/login bigmodel` или обновите `BIGMODEL_API_KEY`.",
	},
	protocolWarning: {
		en: 'BigModel: BIGMODEL_PROTOCOL="{requested}" is not recognized — {api} was registered. ' +
			"Valid values: responses, completions.",
		ru: 'BigModel: BIGMODEL_PROTOCOL="{requested}" не распознано — зарегистрирован {api}. ' +
			"Допустимые значения: responses, completions.",
	},

	// ── bigmodel_search errors (search.ts) ───────────────────────────────
	searchNoKey: {
		en: "No BigModel API key. Run `/login bigmodel` or set BIGMODEL_API_KEY — the search sidecar " +
			"uses the same key as the provider.",
		ru: "Нет ключа BigModel. Выполните `/login bigmodel` или задайте BIGMODEL_API_KEY — " +
			"сайдкар поиска использует тот же ключ, что и провайдер.",
	},
	searchBilling: {
		en: "BigModel: no funds on the account. Search is billed per call — ¥0.01 (search_std), " +
			"¥0.03 (search_pro), ¥0.05 (search_pro_sogou/search_pro_quark); rejections are not billed. " +
			"Top up the balance: {keysUrl}",
		ru: "BigModel: на счете нет средств. Поиск тарифицируется за вызов — ¥0.01 (search_std), " +
			"¥0.03 (search_pro), ¥0.05 (search_pro_sogou/search_pro_quark); отказ не тарифицируется. " +
			"Пополните баланс: {keysUrl}",
	},
	searchEngine: {
		en: "BigModel: unknown search engine ({message}). Valid engines: {engines}.",
		ru: "BigModel: неизвестный поисковый движок ({message}). Допустимые: {engines}.",
	},
	searchAuth: {
		en: "BigModel: the key is invalid, revoked or expired ({message}). Check the key: {keysUrl} — " +
			"then `/login bigmodel` or BIGMODEL_API_KEY.",
		ru: "BigModel: ключ недействителен, отозван или истёк ({message}). Проверьте ключ: {keysUrl} — " +
			"затем `/login bigmodel` или BIGMODEL_API_KEY.",
	},
	searchThrottle: {
		en: "BigModel: the service is overloaded or rate-limited ({message}). Retry later.",
		ru: "BigModel: сервис перегружен или сработал rate limit ({message}). Повторите вызов позже.",
	},
	searchGeneric: {
		en: "BigModel web search: HTTP {status}{codePart} — {message}.",
		ru: "BigModel web search: HTTP {status}{codePart} — {message}.",
	},
	searchUngrounded: {
		en: "BigModel: the builtin search did not run — the response has no web_search array. " +
			"The most likely cause is no funds: in-chat search is billed (¥0.01 std / ¥0.03 pro / " +
			"¥0.05 sogou|quark). The model's answer was discarded — it is not backed by sources. " +
			"Top up the balance: {keysUrl}",
		ru: "BigModel: встроенный поиск не выполнился — в ответе нет массива web_search. " +
			"Наиболее вероятная причина — отсутствие средств: поиск в chat тарифицируется " +
			"(¥0.01 std / ¥0.03 pro / ¥0.05 sogou|quark). Ответ модели отброшен, он не подкреплён " +
			"источниками. Пополните баланс: {keysUrl}",
	},

	// ── /bigmodel menu (index.ts) ────────────────────────────────────────
	menuStatus: {
		en: "Status",
		ru: "Статус",
	},
	menuExposure: {
		en: "Search — tool exposure (now: {current})",
		ru: "Поиск — экспозиция инструмента (сейчас: {current})",
	},
	menuEngine: {
		en: "Search — default engine (now: {engine}, ¥{price}/call)",
		ru: "Поиск — движок по умолчанию (сейчас: {engine}, ¥{price}/вызов)",
	},
	menuAskModel: {
		en: "Search — model for action=ask (now: {model})",
		ru: "Поиск — модель для action=ask (сейчас: {model})",
	},
	statusNotify: {
		en: "bigmodel_search: exposure {exposure}, engine {engine} (¥{price}/call), ask model {askModel}. " +
			"Key: {keyState}. Config: {configPath}",
		ru: "bigmodel_search: экспозиция {exposure}, движок {engine} (¥{price}/вызов), " +
			"модель ask {askModel}. Ключ: {keyState}. Конфиг: {configPath}",
	},
	keyPresent: {
		en: "present",
		ru: "есть",
	},
	keyMissing: {
		en: "missing — /login bigmodel or BIGMODEL_API_KEY",
		ru: "нет — /login bigmodel или BIGMODEL_API_KEY",
	},
	exposurePrompt: {
		en: "bigmodel_search exposure (now {current}):",
		ru: "Экспозиция bigmodel_search (сейчас {current}):",
	},
	exposureSet: {
		en: "bigmodel_search exposure: {picked}.{note} Reloading…",
		ru: "Экспозиция bigmodel_search: {picked}.{note} Перезагрузка…",
	},
	codemodeNote: {
		en: " Requires codemode to be enabled in pi; with codemode off this tool is unreachable.",
		ru: " Требует включённого codemode в pi; без codemode инструмент недостижим.",
	},
	enginePrompt: {
		en: "Default engine (now {current}):",
		ru: "Движок по умолчанию (сейчас {current}):",
	},
	engineSet: {
		en: "Default engine: {picked}. Reloading…",
		ru: "Движок по умолчанию: {picked}. Перезагрузка…",
	},
	askModelPrompt: {
		en: "Model for action=ask (blank = {defaultModel} — free; now {current}):",
		ru: "Модель для action=ask (пусто = {defaultModel} — бесплатная; сейчас {current}):",
	},
	askModelSet: {
		en: "Ask model: {model}{note}. Reloading…",
		ru: "Модель ask: {model}{note}. Перезагрузка…",
	},
	askModelNote: {
		en: " (not a flash id — billed as a regular model turn on top of the search call)",
		ru: " (не flash — тарифицируется как обычный ход модели поверх поискового вызова)",
	},
} satisfies Record<string, { en: string; ru: string }>;

export type MessageKey = keyof typeof MESSAGES;

/** Explicit locale (overrides the environment); `undefined` — auto-detection. */
let override: Locale | undefined;

export function setLocale(locale: Locale | undefined): void {
	override = locale;
}

/**
 * Locale from the environment: `PI_BIGMODEL_LANG` (priority), then the first
 * set of `LC_ALL` / `LC_MESSAGES` / `LANG` (`C`/`POSIX` are skipped);
 * non-`ru` means English.
 */
export function detectLocale(env: Record<string, string | undefined> = process.env): Locale {
	const explicit = env[LANG_ENV_VAR]?.trim();
	// An explicit variable decides alone: falling through to the environment
	// would silently break the priority.
	if (explicit) return explicit.toLowerCase().startsWith("ru") ? "ru" : "en";
	for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[name]?.trim();
		if (!value || value === "C" || value.toUpperCase() === "POSIX") continue;
		return value.toLowerCase().startsWith("ru") ? "ru" : "en";
	}
	return "en";
}

export function getLocale(): Locale {
	return override ?? detectLocale();
}

/** Message in an explicit locale (for tests and previews). */
export function tIn(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
	const template = MESSAGES[key][locale];
	if (!params) return template;
	return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name: string) => {
		const value = params[name];
		return value === undefined ? token : String(value);
	});
}

/** Message in the current locale. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
	return tIn(getLocale(), key, params);
}
