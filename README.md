# pi-bigmodel

Провайдер [BigModel / Zhipu AI](https://open.bigmodel.cn) (GLM-модели: GLM-5.3, GLM-5.2, GLM-5.1/5/5-Turbo, GLM-4.7/4.6/4.5, VLM GLM-5V-Turbo / GLM-4.6V / GLM-4.5V и бесплатные flash-модели) для [pi](https://github.com/earendil-works/pi).

Регистрирует `bigmodel` как first-class pi-ai провайдер:

- курируемый каталог CN-эндпоинта с ценами, пересчитанными из юаней (прайс [docs.bigmodel.cn](https://docs.bigmodel.cn/cn/guide/start/pricing));
- настоящая семантика GLM-размышлений: `thinking: {type}` + `reasoning_effort` (только GLM-5.2/GLM-5.3, у принудительно думающих моделей «off» скрыт — эндпоинт отвечает 400/1210);
- `/login` с подсказкой и ссылкой на страницу ключей;
- аддитивная live-дискавери-надстройка из `GET /models` (новые GLM подхватываются без правки каталога,prices кураторского каталога всегда выигрывают);
- понятное сообщение вместо китайской 401 «令牌已过期或验证不正确».

Стриминг, tool calls, учёт usage/cost делегированы встроенной `openAICompletionsApi` из pi-ai — это тот же протокол, что у встроенного провайдера `zai` (международный endpoint), с compat-флагами, проверенными на живом CN-эндпоинте (2026-09-24).

## Установка

```
pi install ~/pi-plugins/pi-bigmodel
```

## Авторизация

1. `/login bigmodel` — ключ сохраняется в `~/.pi/agent/auth.json`;
2. или `export BIGMODEL_API_KEY=xxxxxxxx.yyyyyyyy`.

Ключи создаются на [open.bigmodel.cn/usercenter/proj-mgmt/apikeys](https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys). Формат — `id.secret`; ключ с хвостовым переводом строки отклоняется так же, как отозванный, поэтому обе ветки обрезают пробелы.

При 401 (ключ истёк/отозван) `message_end` переписывает китайское сообщение в понятное, а `turn_end` добавляет постоянную запись с ссылкой и подсказкой `/login bigmodel` (только в интерактивном TUI: в print/json-режимах `ctx.hasUI === false`, и запись не добавляется — иначе она скрыла бы текст ошибки из вывода `pi -p`, где проверяется «последнее сообщение — ассистент»).

## Модели

Текст (все — reasoning, если не указано иное):

| id | контекст | вывод | thinking | ¥/M in·out·cache |
|---|---|---|---|---|
| `glm-5.3` | 1M | 128K | принудительно, effort low/high/max | 8 · 28 · 2 |
| `glm-5.3-flash` | 1M | 128K | принудительно, low/high/max | 0.8 · 2.8 · 0.23 |
| `glm-5.3-flashx` | 1M | 128K | принудительно, low/high/max | 2 · 7 · 0.57 |
| `glm-5.2` | 1M | 128K | вкл/выкл + effort (none…max) | 8 · 28 · 2 |
| `glm-5.1` | 200K | 128K | вкл/выкл | 6/24 (<32K), 8/28 (≥32K) |
| `glm-5-turbo` | 200K | 128K | вкл/выкл | 5/22, ≥32K 7/26 |
| `glm-5` | 200K | 128K | вкл/выкл | 4/18, ≥32K 6/22 |
| `glm-4.7` | 200K | 128K | принудительно | 3/14, ≥32K 4/16 |
| `glm-4.7-flashx` | 200K | 128K | вкл/выкл | 0.5 · 3 · 0.1 |
| `glm-4.7-flash` | 200K | 128K | вкл/выкл | **бесплатно** |
| `glm-4.6` | 200K | 128K | вкл/выкл | цена не публикуется → ¥0* |
| `glm-4.5-air` | 128K | 96K | вкл/выкл | 0.8/6, ≥32K 1.2/8 |
| `glm-4.5-airx` | 128K | 96K | вкл/выкл | цена не публикуется → ¥0* |
| `glm-4.5-flash` | 128K | 96K | вкл/выкл | **бесплатно** |
| `glm-4-flash-250414` | 128K | 16K | — | **бесплатно** |
| `glm-4-flashx-250414` | 128K | 16K | — | 0.1 · 0.1 · 0.05 |

Зрение (input: text+image):

| id | контекст | вывод | thinking | ¥/M in·out |
|---|---|---|---|---|
| `glm-5v-turbo` | 200K | 128K | вкл/выкл | 5/22, ≥32K 7/26 |
| `glm-4.6v` | 128K | 32K | вкл/выкл | 1/3, ≥32K 2/6 |
| `glm-4.6v-flashx` | 128K | 32K | вкл/выкл | 0.15/1.5, ≥32K 0.3/3 |
| `glm-4.6v-flash` | 128K | 32K | вкл/выкл | **бесплатно** |
| `glm-4.5v` | 64K | 32K | принудительно | 2/6, ≥32K 4/12 |
| `glm-4.1v-thinking-flash` | 64K | 16K | принудительно | **бесплатно** |
| `glm-4.1v-thinking-flashx` | 64K | 16K | принудительно | 2 · 2 |

\* GLM-4.6/4.5/4.5-AirX исчезли из публичного прайса (сентябрь 2026; остались только приватные инстансы). Честный ¥0 лучше выдуманной цифры в отчётах о стоимости.

### Намеренно не включены

- `glm-4v-flash` (16K/1K — бесполезен для агента), `glm-4-long` (1M, но вывод 4K), `AutoGLM-Phone` (20K/2K, телефонный агент);
- немодальные API: embeddings, rerank, GLM-OCR, GLM-Image/CogView/CogVideo, TTS/ASR/Realtime — не chat-completions.

### Компакшен

Переполнение контекста BigModel возвращает тело с китайской формулировкой («输入长度超出…»/«超出上下文…»); `message_end` нормализует её в `context_length_exceeded:` → pi запускает автокомпакшен. 429/частотные лимилы намеренно не матчатся (компакшен не должен срабатывать на rate limit). Регэксп собран по семейству формулировок из доков; конкретный overflow-код на живом ключе не воспроизводился дёшево.

## Цены и валюта

Прайс BigModel — в юанях за миллион токенов, pi ожидает USD за миллион. Пересчёт по курсу `BIGMODEL_CNY_PER_USD` (по умолчанию 6.7252 — мид-маркет 2026-09-15, тот же источник, что у pi-siliconflow). `cacheWrite: 0` — хранение кэша сейчас «限时免费».

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `BIGMODEL_API_KEY` | ключ, если не используется `/login` |
| `BIGMODEL_BASE_URL` | замена эндпоинта (прокси, зеркало; по умолчанию `https://open.bigmodel.cn/api/paas/v4`) |
| `BIGMODEL_CNY_PER_USD` | курс пересчёта цен |

## Почему compat-флаги заданы явно

URL `open.bigmodel.cn` не матчится ни одним из правил авто-детекта pi, и «vanilla OpenAI»-дефолты были бы неверны в пяти местах: reasoning переключается объектом `thinking:{type}` (формат `zai`), `reasoning_effort` принимают только GLM-5.2 и семейство 5.3 (иначе — ошибка), роль `developer` не документирована, поле называется `max_tokens`, а `store`/`prompt_cache_retention`/grammar tools в референсе отсутствуют. `tool_stream:true`, `strict:true` и `response_format` проверены живыми запросами.

## Разработка

```
npm test        # node --test, 52 юнит-теста без сети
npx tsc -p tsconfig.json
BIGMODEL_API_KEY=… npm run live   # живой smoke: все id каталога + thinking-сценарии
```

`node_modules/@earendil-works/*` и `@types/node` — симлинки на установленный pi (не в git), как в pi-siliconflow; `tsconfig.paths` повторяет маппинг compat-энтрипоинта лоадера pi.

### Что покрыто тестами

- инварианты каталога (уникальность id, окна, полосы цен, покрытие живого `/models`);
- конвертация CNY→USD, `cost.tiers`, compat-флаги и карты thinking для всех пяти видов ThinkingControl;
- семейные догадки для неизвестных id (zero-cost, conservative windows);
- парсинг/мерж дискавери, деградация без сети/ключа, отмена;
- auth: `/login` (ссылка на страницу ключей, trim, отказ на пустом), resolve из env/хранилища;
- errors: overflow-нормализация (EN/CN, идемпотентность, guard на rate limit), 401-кларификация.

### Проверено с живым ключом (2026-09-24)

Все 5 тестовых ключей из `secret.env` (KEY1..KEY5) работают со всеми моделями каталога (включая glm-5.3 и VLM; редкие 429 на бесплатных flash — rate limit при серийных запросах, не ограничение ключа). Живые проверки: `thinking.type` вкл/выкл (в т.ч. 400/1210 на glm-5.3), `clear_thinking:false`, `reasoning_effort`, SSE `reasoning_content`, tool calls с `tool_stream`, `strict`, `response_format`, `GET /models` (11 id), 401-тело.
