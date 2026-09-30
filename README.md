# pi-bigmodel

npm-имя пакета — `@rarogcmex/pi-bigmodel`.

Провайдер [BigModel / Zhipu AI](https://open.bigmodel.cn) (GLM-модели: GLM-5.3, GLM-5.2, GLM-5.1/5/5-Turbo, GLM-4.7/4.6/4.5, VLM GLM-5V-Turbo / GLM-4.6V / GLM-4.5V и бесплатные flash-модели) для [pi](https://github.com/earendil-works/pi).

> **In English.** pi-bigmodel registers **BigModel / Zhipu AI**'s China endpoint
> (`open.bigmodel.cn`) as a native pi provider under the id `bigmodel`: a curated
> GLM catalog (24 ids — text and vision), prices taken from the CNY rate card and
> converted to pi's USD `ModelCost`, real GLM thinking semantics
> (`thinking:{type}` plus `reasoning_effort` on GLM-5.2/5.3), `/login`, and an
> additive `GET /models` overlay. Install with
> `pi install git:github.com/RarogCmex/pi-bigmodel@main`, authenticate with
> `/login bigmodel` or `BIGMODEL_API_KEY`. It exists alongside pi's built-in `zai`
> provider, which targets the *international* endpoint and bills in USD — see
> «Зачем это, если в pi уже есть `zai`» below. The rest of this README is in
> Russian. Note that this plugin's user-facing runtime strings are also Russian,
> including the message that replaces the gateway's opaque Chinese 401; that is a
> deliberate language choice, not an oversight, and § Авторизация below says so
> explicitly so a non-Russian user is not surprised.

Регистрирует `bigmodel` как first-class pi-ai провайдер:

- курируемый каталог CN-эндпоинта с ценами, пересчитанными из юаней (прайс [docs.bigmodel.cn](https://docs.bigmodel.cn/cn/guide/start/pricing));
- настоящая семантика GLM-размышлений: `thinking: {type}` + `reasoning_effort` (только GLM-5.2/GLM-5.3, у принудительно думающих моделей «off» скрыт — эндпоинт отвечает 400/1210);
- `/login` с подсказкой и ссылкой на страницу ключей;
- аддитивная live-дискавери-надстройка из `GET /models` (новые GLM подхватываются без правки каталога,prices кураторского каталога всегда выигрывают);
- понятное сообщение вместо китайской 401 «令牌已过期或验证不正确».

**Зачем это, если в pi уже есть провайдер `zai`.** Встроенный `zai` смотрит на
международный эндпоинт и тарифицируется в долларах. Этот плагин — для
китайского `open.bigmodel.cn`: ключ и баланс в CNY, цены из китайского прайса,
совместимые с ним compat-флаги, а также id, которых нет ни во встроенном
каталоге, ни в ответе `GET /models` (бесплатные flash-модели и VLM). Оба
провайдера можно держать включёнными одновременно — это разные `provider id`.

Стриминг, tool calls, учёт usage/cost делегированы встроенной `openAICompletionsApi` из pi-ai — это тот же протокол, что у встроенного провайдера `zai` (международный endpoint), с compat-флагами, проверенными на живом CN-эндпоинте (2026-09-24).

## Установка

```
pi install git:github.com/RarogCmex/pi-bigmodel@main
# или локально
pi install /path/to/pi-bigmodel
```

## Авторизация

1. `/login bigmodel` — ключ сохраняется в `~/.pi/agent/auth.json`;
2. или `export BIGMODEL_API_KEY=xxxxxxxx.yyyyyyyy`.

Ключи создаются на [open.bigmodel.cn/usercenter/proj-mgmt/apikeys](https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys). Формат — `id.secret`; ключ с хвостовым переводом строки отклоняется так же, как отозванный, поэтому обе ветки обрезают пробелы.

При 401 (ключ истёк/отозван) `message_end` переписывает китайское сообщение в понятное, а `turn_end` добавляет постоянную запись с ссылкой и подсказкой `/login bigmodel` (только в интерактивном TUI: в print/json-режимах `ctx.hasUI === false`, и запись не добавляется — иначе она скрыла бы текст ошибки из вывода `pi -p`, где проверяется «последнее сообщение — ассистент»).

> **Язык сообщений.** Обе эти строки — на русском (`errors.ts`, `index.ts`), как и
> весь README. Заявленная цель — заменить непрозрачную китайскую 401 на сообщение,
> которое называет причину и путь решения; для русскоязычного пользователя это
> работает, для остальных замена получается столь же непрозрачной, только на другом
> языке. Это осознанный выбор языка плагина, а не недосмотр: метаданные пакета
> (`description`, `keywords`) и комментарии в коде при этом английские. Если вам
> нужен английский рантайм — это отдельная задача, и начать стоит именно с
> `errors.ts` и `index.ts`, потому что это вывод пользователю, а не документация.

## Модели

Текст (все — reasoning, если не указано иное; 15 id без входа изображений):

| id | контекст | вывод | thinking | ¥/M in·out·cache |
|---|---|---|---|---|
| `glm-5.3` | 1M | 128K | принудительно, effort low/high/max | 8 · 28 · 2 |
| `glm-5.2` | 1M | 128K | вкл/выкл + effort (none…max) | 8 · 28 · 2 |
| `glm-5.1` | 200K | 128K | вкл/выкл | 6/24 (<32K), 8/28 (≥32K) |
| `glm-5-turbo` | 200K | 128K | вкл/выкл | 5/22, ≥32K 7/26 |
| `glm-5` | 200K | 128K | вкл/выкл | 4/18, ≥32K 6/22 |
| `glm-4.7` | 200K | 128K | принудительно | 3/14, ≥32K 4/16 † |
| `glm-4.7-flashx` | 200K | 128K | вкл/выкл | 0.5 · 3 · 0.1 |
| `glm-4.7-flash` | 200K | 128K | вкл/выкл | **бесплатно** |
| `glm-4.6` | 200K | 128K | вкл/выкл | цена не публикуется → ¥0* |
| `glm-4.5` | 128K | 96K | вкл/выкл | цена не публикуется → ¥0* |
| `glm-4.5-air` | 128K | 96K | вкл/выкл | 0.8/6, ≥32K 1.2/8 † |
| `glm-4.5-airx` | 128K | 96K | вкл/выкл | цена не публикуется → ¥0* |
| `glm-4.5-flash` | 128K | 96K | вкл/выкл | **бесплатно** |
| `glm-4-flash-250414` | 128K | 16K | — | **бесплатно** |
| `glm-4-flashx-250414` | 128K | 16K | — | 0.1 · 0.1 · 0.05 |

Зрение (input: text+image; 9 id):

| id | контекст | вывод | thinking | ¥/M in·out |
|---|---|---|---|---|
| `glm-5.3-flash` | 1M | 128K | принудительно, low/high/max | 0.8 · 2.8 · 0.23 |
| `glm-5.3-flashx` | 1M | 128K | принудительно, low/high/max | 2 · 7 · 0.57 |
| `glm-5v-turbo` | 200K | 128K | вкл/выкл | 5/22, ≥32K 7/26 |
| `glm-4.6v` | 128K | 32K | вкл/выкл | 1/3, ≥32K 2/6 |
| `glm-4.6v-flashx` | 128K | 32K | вкл/выкл | 0.15/1.5, ≥32K 0.3/3 |
| `glm-4.6v-flash` | 128K | 32K | вкл/выкл | **бесплатно** |
| `glm-4.5v` | 64K | 32K | принудительно | 2/6, ≥32K 4/12 |
| `glm-4.1v-thinking-flash` | 64K | 16K | принудительно | **бесплатно** |
| `glm-4.1v-thinking-flashx` | 64K | 16K | принудительно | 2 · 2 |

\* GLM-4.6/4.5/4.5-AirX исчезли из публичного прайса (сентябрь 2026; остались только приватные инстансы). Честный ¥0 лучше выдуманной цифры в отчётах о стоимости.

† **Полоса по размеру вывода.** У `glm-4.7` и `glm-4.5-air` указанная цена — это
полоса «вывод ≥ 0.2K токенов»; короткий вывод дешевле (`glm-4.7` — 2/8,
`glm-4.5-air` — 0.8/2). pi получает только основную полосу и ступень ≥32K входа,
поэтому отчёт о стоимости для коротких ответов будет **завышен**. Ограничение
pi-уровня: у `Model` нет поля для примечаний, поэтому оговорка живёт в
`priceNote` каталога и здесь, но не в интерфейсе pi.

`glm-5.3-flash` и `glm-5.3-flashx` — единственные id с задокументированными
лимитами ресайза изображений (2000×2000, ≤4 718 592 байт, JPEG quality 80 —
`GLM53_FLASH_IMAGE_LIMITS` в `catalog.ts`); они же принудительно думающие, то
есть «off» для них недоступен.

### Намеренно не включены

- `glm-4v-flash` (16K/1K — бесполезен для агента), `glm-4-long` (1M, но вывод 4K), `AutoGLM-Phone` (20K/2K, телефонный агент);
- немодальные API: embeddings, rerank, GLM-OCR, GLM-Image/CogView/CogVideo, TTS/ASR/Realtime — не chat-completions.

### Компакшен

Переполнение контекста BigModel возвращает тело с китайской формулировкой («输入长度超出…»/«超出上下文…»); `message_end` нормализует её в `context_length_exceeded:` → pi запускает автокомпакшен. 429/частотные лимилы намеренно не матчатся (компакшен не должен срабатывать на rate limit). Регэксп собран по семейству формулировок из доков; конкретный overflow-код на живом ключе не воспроизводился дёшево.

## Кэш контекста

У BigModel кэш **имплицитный**: сервер сам распознаёт повторяющийся длинный префикс (от ~500 токенов, «стабильное в начале — переменное в конце»), никаких полей в запросе нет. Попадания приходят в `usage.prompt_tokens_details.cached_tokens`, и pi-ai штатно превращает их в `usage.cacheRead`, вычитая из input при расчёте стоимости — каталог уже несёт цену попадания (`cost.cacheRead`, обычно ¥¼–½ от input, у бесплатных моделей — 0), так что учёт стоимости работает без дополнительного кода. Хранение кэша сейчас «限时免费» (потенциально ¥/M/час), поле write-счётчика BigModel не возвращает → `cacheWrite: 0`.

**Ограничение (замерено 2026-09-24).** Попадание кэша есть, но кэш
**асинхронный и непостоянный**: он срабатывает не на каждом повторе
(похоже, состояние шардировано между инстансами). Поэтому `promptCache` в
моделях намеренно не задан — pi-ai оставляет его неуказанным, когда TTL кэша
провайдера неизвестен (из встроенных провайдеров его задают только anthropic с
их явными 5m/1h retention), — и проверки кэша нет в живом smoke-тесте: она
давала бы нестабильный результат.

## Цены и валюта

Источники каталога — публичные страницы Zhipu: `…/guide/start/model-overview`,
`…/guide/start/pricing`, `…/guide/capabilities/thinking`. В комментариях
`catalog.ts` те же адреса даны с суффиксом `.md` — это не опечатка: `docs.bigmodel.cn`
отдаёт по любому такому пути машиночитаемый markdown (вместо SPA-страницы на
~950 КБ), поэтому для сверки значений удобнее именно он. Обе формы работают.

Прайс BigModel — в юанях за миллион токенов, pi ожидает USD за миллион. Пересчёт по курсу `BIGMODEL_CNY_PER_USD` (по умолчанию 6.7252 — срединный рыночный курс на 2026-09-15; тот же дефолт во всех наших плагинах для китайских шлюзов, чтобы отчёты о стоимости были сравнимы). `cacheWrite: 0` — хранение кэша сейчас «限时免费».

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `BIGMODEL_API_KEY` | ключ, если не используется `/login` |
| `BIGMODEL_BASE_URL` | замена эндпоинта (прокси, зеркало; по умолчанию `https://open.bigmodel.cn/api/paas/v4`) |
| `BIGMODEL_CNY_PER_USD` | курс пересчёта цен |

## Почему compat-флаги заданы явно

URL `open.bigmodel.cn` не матчится ни одним из правил авто-детекта pi, и «vanilla OpenAI»-дефолты были бы неверны в пяти местах: reasoning переключается объектом `thinking:{type}` (формат `zai`), `reasoning_effort` принимают только GLM-5.2 и семейство 5.3 (иначе — ошибка), роль `developer` не документирована, поле называется `max_tokens`, а `store`/`prompt_cache_retention`/grammar tools в референсе отсутствуют. `tool_stream:true`, `strict:true` и `response_format` проверены живыми запросами.

## Разработка

```bash
node scripts/link-pi.mjs    # один раз: линкует пакеты pi из глобальной установки
npm run check               # typecheck + 53 офлайн-теста (без сети)
BIGMODEL_API_KEY=… npm run live   # живой smoke: все id каталога + thinking-сценарии
```

**Предварительные условия.** Node ≥ 22.18 — и тесты, и `live/check.ts` это
`.ts`, который исполняется напрямую (нативный type-stripping; обнаружение
`.ts`-тестов у `node --test` включено без флага начиная с 22.18).

`npm install` сам по себе не даёт дерева, пригодного для тайпчека: пакеты pi
(`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@types/node`)
зависимостями не объявлены — в рантайме голый спецификатор `@earendil-works/pi-ai`
подменяет загрузчик расширений pi. Их линкует `scripts/link-pi.mjs`: скрипт сам
находит глобальную установку pi (префикс npm, nvm, pnpm, `~/.local`,
`/usr/local` или каталог, куда резолвится исполняемый `pi`) и создаёт симлинки,
на Windows — junctions. Для конкретной установки:
`PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs`. Проверено на
pi 0.87.1 / pi-ai 0.87.1 / `@types/node` 22.19.19; тот же setup и `npm run check`
повторены на pi 0.99.1 / pi-ai 0.99.1 (2026-09-30) — 53/53 зелёные.

`tsconfig.paths` повторяет маппинг compat-энтрипоинта лоадера pi, чтобы тайпчек
видел то же, что видит pi.

`npm run live` требует `BIGMODEL_API_KEY` и тратит реальную квоту (скрипт
ограничен `max_tokens ≤ 8`, по одному запросу на id каталога).

### Что покрыто тестами

- инварианты каталога (уникальность id, окна, полосы цен, покрытие живого `/models`);
- конвертация CNY→USD, `cost.tiers`, compat-флаги и карты thinking для всех четырёх видов ThinkingControl (`none`, `dynamic`, `effort`, `always`);
- семейные догадки для неизвестных id (zero-cost, conservative windows);
- парсинг/мерж дискавери, деградация без сети/ключа, отмена;
- auth: `/login` (ссылка на страницу ключей, trim, отказ на пустом), resolve из env/хранилища;
- errors: overflow-нормализация (EN/CN, идемпотентность, guard на rate limit), 401-кларификация.

### Проверено на живом шлюзе (2026-09-24)

Флаги совместимости каталога, `thinking.type` вкл/выкл (включая ответ 400/1210 на glm-5.3), `clear_thinking:false`, `reasoning_effort`, SSE `reasoning_content`, tool calls с `tool_stream` / `strict` / `response_format`, `GET /models` (11 id) и тело 401 проверены на живом CN-эндпоинте. Редкие 429 на бесплатных flash — rate limit при серийных запросах, а не ограничение ключа.
