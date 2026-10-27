# browse_task bench

Локальный бенчмарк `browse_task` (петля Jev) в десктопном агенте. Живёт вне
репозиториев и запускается только на этой машине. Отвечает на три вопроса:

1. **Выполняется ли задание?** Каждый сценарий проверяется на стороне сервера
   фикстуры: какой заказ, аккаунт или бронь реально записаны и какое значение
   агент назвал в ответе. Словам агента бенч не верит.
2. **Насколько быстро?** Время всего хода; сколько из него ушло в
   `browse_task`, а сколько в главную модель; латентность шага (клиент и
   сервер, отдельно Jev).
3. **Как часто Jev отдаёт решение LLM?** Попытки каскада и принятые ответы
   каскада (legacy), LLM-текст для TYPE_TEXT, понижение неуверенного
   DONE/BLOCKED (ultrafast).

## Запуск

```bash
cd bench/browse-task
npm install              # один раз; Playwright ставится как библиотека, без браузеров
npm run check            # фикстуры и верификаторы без LLM, ~1 с
npm run bench            # 4 сценария × 3 прогона, политика ultrafast
npm run bench -- --policies ultrafast,legacy --runs 5
npm run bench -- --scenarios form,booking --runs 1 --no-build
npm run report -- results/<папка>          # пересобрать summary.md
```

Что происходит: собирается `pen-editor-desktop` (пропустить: `--no-build`).
Бэкенд и vite запускаются через `infisical run --env=dev` в папке своего
репо: каждый берёт секреты своего Infisical-проекта (Luna,
`VITE_BROWSE_STEP_SCREENSHOT` и т. д.). Переопределения стенда (порт, HOME,
`VITE_AI_API_URL` на локальный бэкенд) идут через `env` после Infisical и
всегда побеждают. Нужен `infisical login`; без Infisical: `BENCH_NO_INFISICAL=1`.
Для каждой политики поднимается локальный бэкенд (`pen-editor-backend`, его
`.env` + переопределения) и vite (`pen-editor`) на 3091/5191. Для каждого
прогона запускается свежий Electron-профиль, открывается новый чат,
отправляется задача, и бенч ждёт конца хода.

| флаг | по умолчанию | |
|---|---|---|
| `--chat-model` | `deepseek/deepseek-v4.1-flash` | модель чата; подменяется в каждом `/api/chat`, пикер не участвует |
| `--policies` | `ultrafast` | `BROWSE_STEP_POLICY` бэкенда; через запятую |
| `--cascade-model` | из `.env`/конфига (`gemini-2.5-flash`) | `BROWSE_CASCADE_MODEL`: каскад в legacy, текст полей в обеих политиках |
| `--prompt` | `task` | `task`: промпт велит отдать всё одному `browse_task`; `free`: голая задача, агент решает сам |
| `--stack` | `local` | `prod`: прод-фронт и прод-бэкенд, политика неизвестна, логов бэкенда нет |
| `--runs` | 3 | прогонов каждого сценария; сценарии чередуются по кругам |

## Сценарии

| id | что проверяет | успех |
|---|---|---|
| `lookup` | поиск, пагинация мимо 4 почти-дублей, чтение карточки | первый ISBN в ответе верный |
| `form` | регистрация на 11 контролов: select с плейсхолдером, radio, чекбокс «не трогать» | запись совпадает поле в поле, ответ содержит ID |
| `booking` | cookie-диалог, автокомплит `<li role=option>`, календарь (следующий месяц), степпер, select, кастомный дропдаун | бронь совпадает; частичный прогресс виден через beacon |
| `shop` | bench-shop из `pen-editor-desktop/e2e/fixtures`: фильтры, сортировка, корзина, чекаут | заказ ровно на hp-02 с верными данными |

`score` — доля пройденных чекпоинтов, по нему видно, как далеко дошёл
неудачный прогон.

## Живой сценарий `livegoal` и оракул конечного состояния

`livegoal` берёт задачу из env: `BENCH_LIVE_URL`, `BENCH_LIVE_GOAL`,
`BENCH_LIVE_EXPECT` (regex по ответу агента). Эта проверка называется
`replyCheck` и верит словам агента: неполный результат тоже даёт 1.00.
Настоящий оракул включается двумя переменными:

| env | |
|---|---|
| `BENCH_LIVE_END_URL` | страница, которую читаем после хода (корзина, страница подтверждения) |
| `BENCH_LIVE_END_CHECK` | чек-лист на естественном языке: что должно быть в конечном состоянии |
| `BENCH_JUDGE_MODEL` | модель судьи, по умолчанию `google/gemini-2.5-flash` (OpenRouter) |

Без `END_URL` и `END_CHECK` оракул молча пропускается (старое поведение).

Что происходит после хода, до закрытия приложения: в главном процессе Electron
создаётся скрытое окно на том же разделе `persist:penbrowser`, что и вкладки
агента (куки, корзина, логины те же). Окно грузит `END_URL`, ждёт загрузку и
3 с, берёт `document.body.innerText` (до 30 000 знаков) и скриншот. Вкладка
агента не трогается; её последний URL пишется в `endState.agentTabUrl`.
Затем судья (LLM) получает цель, чек-лист, текст конечного состояния и ответ
агента и возвращает JSON: `verdict` (`complete|partial|fail|unknown`),
`requirements[]`, `extras`, `duplicates`, `end_state_total`, `reply_total`,
`reply_matches_end_state`, `notes`. Судья судит по странице, ответ для него
лишь заявление. В вердикт прогона добавляется проверка `judgeComplete`
(`verdict === "complete"`); в таблицу «Runs» — колонки judge, reqs ok/total,
extras, duplicates, reply = end state. Старые прогоны без судьи
рисуются с прочерками.

Файлы прогона: `results/<stamp>/<policy>-<scenario>-<n>/` — `end-state.txt`,
`end-state.png`, `judge-input.json`, `judge.json`.

Ключ OpenRouter: в окружении бенча его нет. Вызов судьи идёт в дочернем
процессе `infisical run --env=dev` в папке `pen-editor-backend` (как и бэкенд
в `stack.ts`). Если `OPENROUTER_API_KEY` уже задан в env, берётся он;
`BENCH_NO_INFISICAL=1` отключает Infisical.

Пример: корзина магазина.

```bash
BENCH_LIVE_URL=https://shop.example \
BENCH_LIVE_GOAL="Open https://shop.example and add to the cart: a wireless mouse, a 27 inch 4K monitor, a USB-C hub. Reply with the cart total." \
BENCH_LIVE_EXPECT="total" \
BENCH_LIVE_END_URL=https://shop.example/cart \
BENCH_LIVE_END_CHECK="one item for each of these needs: wireless mouse; 27-inch 4K monitor; USB-C hub; no duplicates; no unrelated items; the cart total is shown" \
npm run bench -- --scenarios livegoal --runs 1 --no-build --prompt free
```

Пример без покупок: подтверждение формы.

```bash
BENCH_LIVE_URL=https://forms.example/contact \
BENCH_LIVE_GOAL="Open https://forms.example/contact and send the contact form as Ann Lee, ann@example.com, subject 'Pricing', message 'Please send the price list'. Reply with the reference number." \
BENCH_LIVE_EXPECT="[A-Z0-9-]{6,}" \
BENCH_LIVE_END_URL=https://forms.example/contact/sent \
BENCH_LIVE_END_CHECK="a confirmation that the message was sent; the name Ann Lee, the email ann@example.com and the subject Pricing are shown; a reference number is shown; no error message" \
npm run bench -- --scenarios livegoal --runs 1 --no-build
```

Страница конца должна быть доступна по прямому URL в сессии агента (корзина
по куки, страница подтверждения без одноразового токена). Если это не так,
судья вернёт `unknown`.

Пересчитать судью по готовому прогону (нужны `end-state.txt` и
`judge-input.json`; обновляются `judge.json`, `run-*.json`, `summary.md`):

```bash
npm run judge -- --dir results/<stamp>                      # все прогоны папки
npm run judge -- --dir results/<stamp>/ultrafast-livegoal-1 # один прогон
```

## Живой набор `@live`

10 сценариев на настоящих сайтах. Каждый идёт с LLM-судьёй конечного состояния.
Цели без входа, оплаты и личных данных; агент останавливается до чекаута.
В прогон по умолчанию набор не входит.

```bash
npm run bench -- --scenarios @live --runs 1 --no-build
npm run bench -- --scenarios form,@live --runs 1 --no-build   # можно смешивать
```

| id | сайт | что проверяет | оракул |
|---|---|---|---|
| `live-bahn` | bahn.de | станции, дата и время, BahnCard 25, прямой поезд | `agent-tab` |
| `live-ikea` | ikea.com/de | вариант PAX, склад магазина, 2 шт. в корзину | `/shoppingcart/` |
| `live-apple` | apple.com/shop | конфигуратор MacBook Pro, в корзину | `/shop/bag` |
| `live-amazon` | amazon.de | фильтры, цвет, отказ от страховки, корзина | `/gp/cart/view.html` |
| `live-rightmove` | rightmove.co.uk | аренда, радиус, спальни, цена, сортировка | `agent-tab` |
| `live-gmaps` | google.com/maps | open now, рейтинг, маршрут на транспорте | `agent-tab` |
| `live-stockanalysis` | stockanalysis.com/stocks/screener | диалог «Add Filters», диапазоны, вкладки вида, сортировка по yield (TradingView заменён: его фильтры требуют входа) | `agent-tab` |
| `live-ebay` | ebay.com | фильтры, доставка на Кипр, сортировка, лот | `agent-tab` |
| `live-opentable` | opentable.com | дата, время, 4 гостя, слоты рядом с 19:00 | `agent-tab` |
| `live-github` | github.com | поиск репо, релиз, issues с меткой `feature` | `agent-tab` |

**Режим `agent-tab`.** Если `endUrl` равен `agent-tab`, бенч не открывает
скрытое окно и ничего не навигирует. Он берёт последнюю внешнюю вкладку агента
(http(s), не localhost), читает `document.body.innerText`, снимает
`capturePage()` и пишет `end-state.txt` и `end-state.png`. Адрес этой вкладки
идёт судье как `endUrl`. Нет вкладки: `error = "no agent tab"`, файлы не пишутся.

**Риски.** Amazon и Google могут показать CAPTCHA: такой прогон не виноват
агент. Цены и наличие меняются, поэтому судья проверяет состояние (фильтры,
товар, количество), а не числа. `verify` по ответу лишь грубая проверка и
пустой ответ не пропускает.

## Как читать отчёт (`results/<stamp>/summary.md`)

- **success / by browse_task alone.** Первое — успех хода целиком.
  Второе — успех без единого меняющего страницу `browse_*`, кроме
  `browse_task` (то есть главная модель не доделывала руками). Для оценки
  самого `browse_task` важно второе.
- **in browse_task / in chat model.** Время исполнения клиентских тулов
  между запросами чата и суммарное время запросов `/api/chat`.
- **steps/run (min).** Решений Jev за прогон; в скобках ручная оценка
  минимума.
- **repeats.** Одно и то же действие по тому же элементу два шага подряд.
  **no-effect** — шаги, которые транскрипт пометил как «без эффекта».
- **cascade tried / used.** В ответе шага есть `timings.cascadeMs` /
  `cascade: true`. В `ultrafast` каскада нет по устройству, там смотреть
  **text LLM** и **demoted**.
- **tiers.** `diag.tier` из лога бэкенда: `jev | noul | cascade | rule | retry`.

Сырые данные: `run-<policy>-<scenario>-<n>.json`. Внутри каждый запрос
`/api/chat` (время, тулы, текст), каждый `/api/browse/step` (запрос, ответ,
тайминги), строки лога бэкенда `browse step decided` с пиками гейтов,
транскрипты `browse_task`. Логи бэкенда и vite лежат там же.

## Ограничения

- Время живых прогонов шумит на ±30 с. Сравнивать медианы на ≥3 прогонах, а
  лучше число шагов и латентность шага.
- Бэкенд запускается с отдельным `HOME` (иначе он затирает
  `~/.pen-editor/mcp.json` десктопа) и пустым `TRACE_DATABASE_URL`, чтобы
  трейсы бенча не попадали в Neon.
- Electron запускается с `--disable-blink-features=AutomationControlled`:
  без флага `navigator.webdriver = true`. Для фикстур это неважно, для
  настоящих сайтов обязательно.
- `/api/browse/step` ограничен 60 запросами в минуту на IP. Параллельно с
  бенчем ничего не гонять.

## Online-Mind2Web (`@om2w`)

Подвыборка публичного бенчмарка Online-Mind2Web: сравнение по задачам с
опубликованными результатами Browser Use и Operator. Оракул тот же LLM-судья
по вкладке агента (`endUrl: agent-tab`), чек-лист = официальные key points.
Судья НЕ официальный WebJudge (другая модель и другие входы), числа
ориентировочные. Опубликованные оценки лежат в `data/om2w/{browser_use,operator}.json`.

```bash
# 1. Один раз: датасет закрыт (gated), нужен HF_TOKEN (или локальный файл)
HF_TOKEN=hf_... npm run om2w:prepare -- --n 30 --seed om2w-1
npm run om2w:prepare -- /path/Online_Mind2Web.json --dry-run    # без записи
# → data/om2w/sample.json: 10 easy + 10 medium + 10 hard, детерминированно

# 2. Оба режима параллельно, на разных портах
npm run bench -- --scenarios @om2w --runs 1 --prompt task   --backend-port 3091 --vite-port 5191 &
npm run bench -- --scenarios @om2w --runs 1 --prompt manual --no-build --backend-port 3092 --vite-port 5192 &
wait

# 3. Отчёт по задачам: наш судья vs Browser Use vs Operator на тех же задачах
npm run om2w:report -- results/<task-dir> results/<manual-dir>
```

Без `sample.json` группа `@om2w` пуста, а `cli` просит запустить `om2w:prepare`.

## WebVoyager (`@webvoyager`)

Подвыборка WebVoyager (He et al. 2024): 3 задачи на сайт × 15 сайтов = 45.
Данные: `data/webvoyager/{WebVoyager_data.jsonl,reference_answer.json}` (копии из
`MinorJerry/WebVoyager`, только `JSON.parse`). `wv:prepare` выкидывает задачи,
которые сегодня невыполнимы (абсолютные даты и сезоны в прошлом, логин,
покупка/бронь), список с причинами лежит в `data/webvoyager/excluded.txt`.
Оракул: тот же LLM-судья по вкладке агента, но в режиме `replyIsAnswer`:
оценивается финальный ответ, эталон 2023 года в чек-листе (golden = совпасть
по сути, possible = один из допустимых). Это НЕ GPT-4V авто-оценщик
WebVoyager, числа ориентировочные. Постранично результатов Browser Use нет:
опубликован только агрегат (89.1% на 586 задачах, самоотчёт).

```bash
npm run wv:prepare -- --n 45 --seed wv-1        # --fetch перекачает данные, --dry-run не пишет
npm run bench -- --scenarios @webvoyager --runs 1 --prompt task   --backend-port 3091 --vite-port 5191 &
npm run bench -- --scenarios @webvoyager --runs 1 --prompt manual --no-build --backend-port 3092 --vite-port 5192 &
wait
npm run wv:report -- results/<task-dir> results/<manual-dir>
```

## WebTestBench (`@wtb`, `@wtb-e2e`): QA-агент ищет баги

Источник: [WebTestBench](https://github.com/friedrichor/WebTestBench) (arXiv 2603.25226,
Apache-2.0, HF `friedrichor/WebTestBench`, без токена). 100 веб-приложений, их сгенерировал
Lovable. У каждого приложения есть золотой чек-лист (в среднем 17,5 пункта). Пункт с
`pass: false` — настоящий дефект. Всего 1750 пунктов и 448 дефектов. Классы пунктов:
functionality, constraint, interaction, content.

Две дорожки, как в статье:

| группа | что агент получает | как считается |
|---|---|---|
| `@wtb` (oracle) | URL, инструкцию разработчика и золотой чек-лист | здесь, без LLM: пункт за пунктом по ID |
| `@wtb-e2e` | URL и инструкцию разработчика, чек-лист пишет сам | официальный `eval/scoring.py` с LLM-матчером |

```bash
npm run wtb:prepare -- --n 20 --seed wtb-1      # скачать, собрать 100 приложений, выборка 20
BENCH_TURN_CAP_MS=1800000 npm run bench -- --scenarios @wtb --prompt agent --runs 1 --no-build
npm run wtb:report -- results/<папка>
```

- `wtb:prepare` распаковывает приложение в `data/wtb/apps/<id>`, ставит зависимости
  (`npm ci --ignore-scripts`), собирает `vite build` с React в режиме development (авторы
  гоняют `npm run dev`, поэтому двойные эффекты StrictMode остаются), удаляет `node_modules`.
  Остаётся только `dist/` (~1 МБ). Одно приложение собирается ~8 с. Это сторонний код.
  Скрипт собирает приложение, только если `vite.config.ts` совпадает с одним из двух
  шаблонов Lovable, которые мы проверили 24.10.2026.
- Без `sample.json` в группу попадают все собранные приложения.
- Каждый прогон раздаёт `dist/` на новом порту `127.0.0.1` с SPA-fallback. Свежий профиль
  Electron даёт пустой localStorage.
- Агент отвечает чек-листом: `- [X] FT-01: …` (pass), `- [ ] FT-01: …` + `  - Bug: …` (fail)
  или `- [?] FT-01: …` + `  - Blocked: …` (не удалось проверить). `[?]` считается pass: официальный
  парсер такую строку отбрасывает, а пропущенный пункт у него — pass. В `result_extracted.md`
  `[?]` переписывается в `[X]`. `wtb:report` печатает число `[?]` и сколько из них — золотые дефекты.
- Метрика: позитивный класс — fail. P/R/F1 считаются для каждого приложения и усредняются
  (macro), как в Table 11 статьи. Пункт без строки в ответе считается pass, как в
  официальном скорере. `score` в общем summary — доля верных пунктов.
- `wtb:report` пишет `wtb-summary.md` и раскладку `wtb-official/<track>/<record>/result_extracted.md`
  для официальных скореров.

Ориентиры из статьи (oracle, 100 приложений, macro P/R/F1 %): Claude Sonnet 4.5 61,0/47,4/**49,2**;
GPT-5.1 47,0/63,4/46,8; Step-3.5-Flash 53,4/38,7/40,9; MiMo-V2-Flash 44,3/30,4/31,9.
E2E, лучший F1: GPT-5.1 26,4. Их агент — Claude Code + Playwright MCP, только DOM, без скриншотов,
лимит 100 вызовов тулов. Наша выборка из 20 приложений даёт ориентир, не место в таблице.
