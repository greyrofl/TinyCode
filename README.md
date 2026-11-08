<div align="center">

<pre>
█████ ███ █   █ █   █  ████  ███  ████  █████
  █    █  ██  █ █   █ █     █   █ █   █ █
  █    █  █ █ █  █ █  █     █   █ █   █ ████
  █    █  █  ██   █   █     █   █ █   █ █
  █   ███ █   █   █    ████  ███  ████  █████
</pre>

### Терминальный coding-агент для локальных моделей

`llama.cpp` · `Ollama` · `OpenAI-compatible` · `GGUF` · `TUI`

[![version](https://img.shields.io/badge/version-0.7.1-7dd3fc?style=flat-square)](#что-нового-в-071)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020.11-339933?style=flat-square&logo=node.js&logoColor=white)](#быстрый-старт)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4b5563?style=flat-square)](#быстрый-старт)
[![license](https://img.shields.io/badge/license-MIT-86efac?style=flat-square)](LICENSE)

</div>

TinyCode — локальный coding-агент с собственным TUI, agent loop и 29
инструментами. Он запускает GGUF напрямую через
[llama.cpp](https://github.com/ggml-org/llama.cpp), работает с
[Ollama](https://ollama.com) и подключается к пользовательским
OpenAI-compatible API.

TinyCode рассчитан на модели, которым нужен строгий harness: staged tools,
read-before-edit, контроль повторов, durable history, context compaction,
очередь сообщений и отдельная проверка цели через `/goal`.

> Модельные веса автоматически не скачиваются. Если отсутствует сам
> `llama-server`, TinyCode может установить официальный бинарный релиз с
> проверкой размера и SHA-256.

## Содержание

- [Быстрый старт](#быстрый-старт)
- [Что нового в 0.7.1](#что-нового-в-071)
- [Что нового в 0.7.0](#что-нового-в-070)
- [Что нового в 0.6.0](#что-нового-в-060)
- [Движки и модели](#движки-и-модели)
- [Agent loop, очередь и goal](#agent-loop-очередь-и-goal)
- [Контекст и память](#контекст-и-память)
- [Tools](#tools)
- [CLI и TUI](#cli-и-tui)
- [Конфигурация](#конфигурация)
- [Производительность](#производительность)
- [Разработка](#разработка)
- [Ограничения](#ограничения)

---

## Быстрый старт

Нужен **Node.js 20.11+** и локальная instruct-модель.

```bash
git clone https://github.com/greyrofl/TinyCode.git
cd TinyCode
npm install
npm run build
npm link
```

### Вариант 1: локальный GGUF через llama.cpp

```bash
cd ~/projects/my-app
tinycode --provider llama.cpp --model /path/to/model.gguf
```

Если `llama-server` уже находится в PATH или указан через
`llama.executable`, TinyCode использует его. Иначе движок устанавливается в
`~/.tinytcode/engines/llama.cpp` при первой загрузке модели.

### Вариант 2: Ollama

```bash
ollama pull qwen2.5-coder:7b
cd ~/projects/my-app
tinycode --provider ollama --model qwen2.5-coder:7b
```

### Интерактивный выбор

```bash
tinycode
```

Главный экран открывается без загрузки весов. Используйте `/models`: модели
показаны единым списком с секциями **Ollama**, **llama.cpp** и настроенных
внешних providers.

GGUF автоматически ищутся в:

- `~/.tinytcode/models`;
- `./models` текущего проекта;
- `LLAMA_CACHE` или `~/.cache/llama.cpp`;
- каталогах `llama.modelDirs`;
- локальном Ollama cache — без копирования многогигабайтных blobs.

---

## Что нового в 0.7.1

- **Добавлена поддержка встроенного Qwen MTP**: MTP-head определяется по GGUF
  metadata, отдельный sidecar не нужен. Gemma продолжает использовать свой
  sidecar без изменения настроек.
- Qwen XML tool calls проходят общий schema/approval/read-before-edit pipeline;
  литеральные теги и содержимое создаваемых файлов сохраняются.
- `/info` показывает фактически загруженный MTP mode и draft depth.
- Исправлено распознавание `node --experimental-strip-types --test`, в том числе
  после `cd … &&`, как выполненной проверки.

Предрелизная проверка **Qwen3.6-35B-A3B-MTP UD-IQ4_XS** на RTX 3050 8 ГБ,
32K context, thinking on, seed 42:

| MTP depth | Решено | Взвешенная скорость | Acceptance | Время трёх задач |
| --- | ---: | ---: | ---: | ---: |
| x2 | 3/3 | 27.28 tok/s | 85.9% | 392.7 с |
| x3 | 3/3 | 27.23 tok/s | 79.1% | 352.6 с |

Глубины x4/x6/x16 завершили только Cache: 26.17/23.37/14.51 tok/s соответственно.
Это один seed и три задачи, **не результат полного 10-case suite**. Контроля без
MTP нет; x3 сократил agent-loop, но не увеличил скорость генерации относительно
x2. У x2 независимые проверки прошли, несмотря на ложный completion FAIL,
исправленный в 0.7.1.

Подробности: [`docs/RELEASE_0.7.1.md`](docs/RELEASE_0.7.1.md),
[`docs/QWEN_MTP_BENCHMARK.md`](docs/QWEN_MTP_BENCHMARK.md) и
[`data/qwen-mtp.json`](data/qwen-mtp.json).

---

## Что нового в 0.7.0

TinyCode 0.7 ориентирован на локальные coding-модели примерно от 8B,
а основной оптимизированный путь — Gemma 4 через managed llama.cpp.

- После выбора модели setup последовательно предлагает **thinking** и
  **inference profile**: Standard, N-gram, MTP 2x/3x/6x/8x.
- MTP sidecar задаётся отдельно для целевой модели. TinyCode ищет локальные
  draft GGUF, но никогда не скачивает веса автоматически.
- Верхняя строка TUI показывает сохранённые сессии текущей рабочей папки как
  вкладки. Закрытая вкладка не возвращается после перезапуска, но сессия не
  удаляется и может быть явно открыта через `/sessions`; `+` создаёт новую.
- Picker-меню используют semantic colors для статусов и профилей; длинные
  descriptions, metadata и footer-подсказки переносятся, а полные данные
  выбранного пункта показываются отдельным preview-блоком.
- `/recommend` использует расширенный каталог моделей 8B–32B и учитывает веса,
  F16 KV cache, резерв ОС/compute и VRAM/RAM placement.
- Исследовательские данные существующих прогонов собраны в
  [`data/model-efficiency.json`](data/model-efficiency.json), но пока не
  публикуются на сайте как leaderboard.

Полное описание релиза: [`docs/RELEASE_0.7.md`](docs/RELEASE_0.7.md).
Исходный scope: [`docs/ROADMAP_0.7.md`](docs/ROADMAP_0.7.md).

---

## Что нового в 0.6.0

### Очередь запросов

Обычное сообщение во время agent run больше не отклоняется. Оно сохраняется в
FIFO-очередь и передаётся модели после текущего tool observation, перед следующим
model request. Параллельных веток модели или файловых операций не создаётся.

Пока сообщение ожидает отправки, оно отображается тихой серой строкой внизу
transcript. Очередь хранится в метаданных сессии и защищена от дубликатов при
checkpoint/resume.

### `/goal <task>`

```text
/goal Исправить авторизацию и проверить вход
```

После candidate final запускается отдельный evaluator. У него нет project tools,
только два виртуальных verdict-вызова:

- `continue_work` — вернуть feedback основному агенту и продолжить;
- `work_done` — принять final и удалить goal.

Goal Review отображается свёрнутым блоком и раскрывается кликом. Число
continuations ограничено. По умолчанию evaluator использует активную модель;
в конфиге можно назначить другой provider/model.

```text
/goal off
```

отключает активную цель.

### Новая completion policy

`verify` остаётся доступным инструментом, но больше не является обязательным
после любого изменения. TinyCode требует фактический evidence, когда:

- пользователь явно попросил запустить tests/build/typecheck;
- модель заявляет, что проверки прошли.

Отрицательные формулировки вроде «я **не утверждаю**, что тесты прошли» не
считаются заявлением об успехе. Для research, чтения проекта и задач с явным
запретом тестов evaluator не требует бессмысленную проверку.

### Web search

Новый `web_search` использует no-key endpoint DuckDuckGo и возвращает title,
URL и snippet. Результаты считаются недоверенными; содержимое выбранного источника
агент читает через `fetch_url`.

DuckDuckGo может временно ограничить no-key HTML endpoint. TinyCode сообщает
такую ошибку явно и не подменяет результаты выдуманным ответом.

### OpenAI-compatible providers

Можно добавить пользовательский локальный или удалённый сервер. Модели,
context и thinking capabilities задаются вручную; TinyCode не пытается угадать
RAM/VRAM, загрузить модель или перезапустить чужой процесс.

### Рекомендации моделей

`/recommend` сравнивает встроенный каталог с общими RAM/VRAM и оценивает модель
при контексте не меньше 32k. В 0.7 каталог расширен до восьми coding и
agentic моделей размером 8B–32B. Результаты делятся на:

- **VRAM only**;
- **Hybrid RAM / VRAM**;
- **RAM only**.

Install command запускается только после обычного command approval.

---

## Движки и модели

| Возможность | llama.cpp | Ollama | OpenAI-compatible |
| --- | --- | --- | --- |
| Модели | локальный GGUF | библиотека Ollama | вручную в конфиге |
| Управление процессом | owned `llama-server` | локальный `ollama serve` | сервер пользователя |
| RAM/VRAM telemetry | да, если доступна | `/api/ps` | нет |
| Physical context reload | controlled child restart | unload/reload runner | не управляется |
| Thinking | GGUF template + `/props` | `/api/show` | вручную в конфиге |
| Автоустановка движка | официальный verified binary | нет | нет |

Новые конфиги используют llama.cpp. Существующие конфиги и сессии без поля
`provider` остаются на Ollama.

При переходе Ollama → llama.cpp выгружается только matching выбранный Ollama
runner. Daemon и другие модели не останавливаются. Это предотвращает одновременную
загрузку двух копий одного большого GGUF.

На Windows direct llama.cpp по умолчанию использует:

- `loadMode: "none"` — без удержания полного mmap GGUF в working set;
- `fitTargetMiB: 512`;
- batch/ubatch `256`;
- `parallel: 1`.

Внешний или чужой llama-server никогда не останавливается автоматически.

Подробнее: [`docs/ENGINES.md`](docs/ENGINES.md).

---

## Agent loop, очередь и goal

```text
user → model stream → tool → observation → model stream → candidate final
          ↑                                     │
          └──── queued steering ────────────────┘
                                                │
                                       goal evaluator
                                      ↙              ↘
                              continue_work       work_done
```

Reasoning, обычный текст и tool-call одного model request приходят единым
stream. После tool-call TinyCode выполняет инструмент локально и только затем
делает следующий запрос модели. Поэтому queued input внедряется после завершения
tool, а не параллельно ему.

Каждый tool проходит через общий pipeline:

1. parse/repair протокола;
2. проверка active profile;
3. read-before-edit и repeat guards;
4. approval, если требуется;
5. выполнение;
6. `[Observation: ...]` в следующем model request.

Поддерживаются оба tool-формата:

```text
<tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</tool_call>
```

и нативный llama.cpp/Gemma DSL:

```text
<|tool_call>call:read_file{path:"src/index.ts"}<tool_call|>
```

Нативный DSL скрывается из обычного ответа, преобразуется в JSON и проходит те
же guards/approval. Незавершённый tool-call никогда не исполняется.

---

## Контекст и память

TinyCode не загружает модель при открытии TUI или выборе модели. Первое сообщение
сначала сохраняется, затем модель загружается с небольшим baseline и открывается
memory-aware context picker.

Для llama.cpp picker показывает:

- **Estimated fit** — рекомендацию по текущим RAM/VRAM и KV metadata;
- **Model limit** — предел из GGUF;
- варианты выше оценки — доступны и помечены `verify on reload`.

Оценка llama.cpp не является жёстким потолком: `--fit` может перераспределить
weights между VRAM и RAM во время reload. Если выбранный размер не помещается,
TinyCode делает один bounded cleanup/retry и откатывает context без потери prompt.

До compaction модель получает всю активную историю — без старого ограничения
24 messages / 24k characters. При давлении старый завершённый префикс сжимается
в durable Markdown memory. Исходные сообщения остаются в `messages.jsonl`.

Перед llama.cpp generation вся история дополнительно проходит через собственные
`/apply-template` и `/tokenize`; если реальное число токенов не помещается,
запрос отклоняется без скрытой truncation/context shift.

Строка `model traffic` под ответом суммирует input/output всех model requests
одного agent turn; это не размер текущего контекста. Footer `ctx` показывает
активное окно, а `/info` отдельно показывает **Compact pressure** с учётом
резерва следующего ответа и порог автоматического сжатия.

---

## Tools

29 встроенных инструментов плюс tools подключённых MCP-серверов.

| Группа | Инструменты |
| --- | --- |
| Чтение | `read_file`, `read_files`, `list_dir`, `find_files`, `search_text`, `file_info` |
| Изменение | `create_file`, `replace_file`, `edit_file`, `apply_patch` |
| Пути | `make_directory`, `move_path`, `copy_path`, `delete_file`, `delete_directory` |
| Git | `git_status`, `git_diff`, `git_log`, `git_show` |
| Проверка | `diagnostics`, `verify` |
| Команды | `execute_command` |
| Процессы | `start_process`, `process_status`, `list_processes`, `stop_process` |
| Интернет | `web_search`, `fetch_url` |
| Ответ | `say` |

Файловые операции, чтение, поиск и HTTP fetch выполняются автоматически.
Approval требуется для `execute_command`, `start_process`, `verify` и MCP tools
с явным `safe:false`.

Файловые tools ограничены рабочей папкой; `..` и symlink escapes запрещены.
Commands и MCP не являются sandbox — подключайте только доверенные программы.

### Tool profiles

| Профиль | Назначение |
| --- | --- |
| `auto` | staged plan → edit → review |
| `plan` | чтение, поиск, git и diagnostics |
| `edit` | чтение + изменение + checks |
| `full` | всё, включая shell/process/network/MCP |

При `tools.profileByModel: true`: модели меньше 20B получают `auto`, от 20B —
`full`. Для MoE используется полный размер, а не active parameters.

---

## CLI и TUI

### CLI

```text
tinycode [options]                 интерактивный TUI
tinycode run [options] [prompt]    one-shot; читает stdin из pipe
tinycode resume [session]          продолжить сессию
tinycode compact [session]         сжать старую историю
tinycode models [--json]           модели выбранного provider
tinycode tools [--json]            tools и approval
tinycode sessions [--json]         сохранённые сессии
tinycode config [--path|--json]    конфигурация
tinycode doctor                    диагностика
```

Основные флаги:

| Флаг | Назначение |
| --- | --- |
| `--provider <id>` | llama.cpp, Ollama или configured provider |
| `-m, --model <id>` | модель / путь к GGUF |
| `--context <n>` | context текущей сессии |
| `--think <mode>` | режим thinking |
| `--inference <name>` | `standard`, `ngram`, `mtp-2`, `mtp-3`, `mtp-6`, `mtp-8` |
| `--draft-model <gguf>` | локальный MTP sidecar для выбранной модели |
| `--profile <name>` | `auto`, `plan`, `edit`, `full`, `model` |
| `-y, --yes` | автоматически разрешать approval-команды |
| `--thinking` | писать reasoning в stderr в one-shot режиме |

В `tinycode run` stdout содержит только обычный ответ; statuses, tools,
reasoning и approvals идут в stderr.

### Slash-команды

| Команда | Действие |
| --- | --- |
| `/models` | модели, сгруппированные по providers |
| `/model [id]` | выбрать модель текущего provider |
| `/provider [id]` | явно сменить provider |
| `/recommend` | модели под доступные RAM/VRAM |
| `/goal <task>` | задать цель evaluator; `/goal off` — очистить |
| `/context [tokens]` | context picker / ручной размер |
| `/think [mode]` | thinking mode |
| `/inference [profile]` | Standard, N-gram, встроенный Qwen или Gemma-sidecar MTP |
| `/profile [name]` | tool profile |
| `/new`, `/sessions` | новая / другая сессия |
| `/retry` | повторить последний user request |
| `/compact`, `/memory` | сжатие / compacted memory |
| `/tools`, `/info` | tools / информация о сессии |
| `/reasoning` | показать/скрыть reasoning |
| `/export [path]` | экспорт Markdown |
| `/clear`, `/quit` | очистить экран / выйти |

### Markdown

Ответы модели поддерживают headings, **bold**, *italic*, списки, цитаты,
ссылки, inline code и fenced code blocks. Незавершённая streaming-разметка
перерисовывается по мере поступления ответа.

---

## Конфигурация

```text
~/.tinytcode/config.json
```

### llama.cpp

```json
{
  "provider": "llama.cpp",
  "model": "gemma-4-26b",
  "llama": {
    "modelDirs": ["D:/models"],
    "models": {
      "gemma-4-26b": "D:/models/gemma-4-26B-A4B-it-Q4_K_M.gguf"
    },
    "backend": "auto",
    "gpuLayers": "auto",
    "loadMode": "none",
    "fitTargetMiB": 512,
    "parallel": 1,
    "speculativeType": "none"
  }
}
```

`speculativeType` принимает `none`, экспериментальный `ngram-mod` или
`draft-mtp` для совместимых свежих сборок llama-server. `speculativeMtpMode`
принимает `auto`, `embedded` или `sidecar`. Для sidecar MTP задаётся
`speculativeDraftModel`; для обоих вариантов — `speculativeDraftDevice`
(`auto`/`cpu`) и `speculativeDraftMax`. N-gram не загружает вторую модель; режимы должны
измеряться отдельно от смены runtime.

Предпочтительный интерфейс — `/inference`: выбор хранится отдельно для
каждой модели и применяется при следующей managed-загрузке. Для one-shot режима
доступны `--inference <profile>` и `--draft-model <path.gguf>`.

Встроенный Qwen MTP поддерживается с **0.7.1**: GGUF с
`nextn_predict_layers` не требует `--draft-model`. Его head использует placement
целевой модели, `parallel=1` и точную выбранную draft depth. Обычный Qwen GGUF без
MTP-весов не считается совместимым только из-за имени модели. Подробнее:
[`docs/ENGINES.md`](docs/ENGINES.md#встроенный-qwen-mtp-071).

### Goal evaluator override

По умолчанию используется активная модель:

```json
{
  "goal": {
    "enabled": true,
    "provider": null,
    "model": null,
    "numPredict": 512,
    "maxContinuations": 3
  }
}
```

`provider` и `model` можно назначить на другой configured provider.

### OpenAI-compatible provider

```json
{
  "provider": "local-ai",
  "providers": {
    "local-ai": {
      "type": "openai-compatible",
      "name": "My Local Server",
      "baseUrl": "http://127.0.0.1:9000/v1",
      "apiKeyEnv": "LOCAL_AI_KEY",
      "headers": {},
      "extraBody": {},
      "models": {
        "coder": {
          "name": "Coder",
          "contextLength": 32768,
          "parameterSize": "14B",
          "thinking": false
        }
      }
    }
  }
}
```

Для thinking-модели можно явно задать modes и mapping:

```json
{
  "thinking": {
    "modes": ["off", "high"],
    "defaultMode": "off",
    "field": "reasoning_effort",
    "values": { "off": "none", "high": "high" }
  }
}
```

Секреты храните в переменных окружения, указанных через `apiKeyEnv`. Для
удалённого URL prompts, история и tool results покидают локальный компьютер.

### Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `TINYCODE_HOME` | каталог config/history/sessions/engines |
| `TINYCODE_PROVIDER` | provider по умолчанию |
| `TINYCODE_MODEL` | model id / GGUF path |
| `TINYCODE_LLAMA_URL` | адрес llama-server |
| `TINYCODE_LLAMA_EXECUTABLE` | путь к llama-server |
| `TINYCODE_OLLAMA_URL` / `OLLAMA_HOST` | адрес Ollama |
| `TINYCODE_PROMPT` | системный prompt |
| `TINYCODE_COMPACTION_PROMPT` | prompt summarizer |

---

## Производительность

Пример наблюдаемой generation speed на RTX 3050 8 ГБ, `parallel=1`:

| Модель | Измеренная скорость |
| --- | ---: |
| 7B test build | 70 tok/s |
| 14B test build | 5 tok/s |
| Gemma 4 26B A4B | 30 tok/s |

Это локальные замеры, а не универсальный benchmark. На результат влияют GGUF,
quant, context, offload, engine build, prompt processing и свободная память.

Спецификация будущего сравнения TinyCode/OpenCode V2:
[`docs/BENCHMARK_0.6.md`](docs/BENCHMARK_0.6.md).

---

## Сессии и данные

```text
~/.tinytcode/
  config.json
  history.json
  engines/
  models/
  sessions/
    ses_xxx/
      meta.json
      messages.jsonl
```

`messages.jsonl` хранит исходную ordered history. `meta.json` содержит provider,
model, context, goal, queue и compaction cursor. Доступны resume, retry, manual
compaction и Markdown export.

---

## Разработка

```bash
npm run typecheck
npm run build
npm run smoke
npm run smoke:tui
npm pack --dry-run
node scripts/collect-model-efficiency.mjs D:/TinyBench data/model-efficiency.json
```

Smoke tests не скачивают llama.cpp или модели и не запускают реальный inference.
Они проверяют agent loop, queue, goal review, tools, compaction, provider
protocols, context lifecycle, OOM/cancel и TUI layout на детерминированных моках.

### Структура

```text
src/
  cli.ts
  core/
    chat.ts                       scheduler, queue, goal evaluator
    context.ts                    full-history context builder
    compaction.ts                 durable memory/checkpoints
    engines.ts                    provider/runtime switching
    llama-runtime.ts              managed llama-server
    llama-install.ts              verified engine installation
    model-recommendations.ts      seed hardware catalog
    provider/
      llama.ts
      ollama.ts
      openai-compatible.ts
  tools/
  tui/
```

Архитектура подробно описана в
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Ограничения

- Встроенные managed-движки — llama.cpp и Ollama; остальные endpoints
  описываются пользователем вручную.
- Мультимодальный ввод пока не поддерживается.
- DuckDuckGo no-key search может быть rate-limited.
- OpenAI-compatible provider не получает автоматическую memory telemetry.
- MCP поддерживает stdio/tools, но пока не HTTP/resources/prompts.
- LSP требует установленный language server; fallback не заменяет полный LSP.
- Нет project-local `.tinycode.json` и syntax highlighting исходников.
- Commands и MCP работают с правами пользователя, не в sandbox.
- Goal evaluator повышает надёжность, но остаётся модельной оценкой, а не
  формальным доказательством корректности.

---

## Документация

| Документ | Содержание |
| --- | --- |
| [`docs/RELEASE_0.7.1.md`](docs/RELEASE_0.7.1.md) | поддержка Qwen MTP и изменения 0.7.1 |
| [`docs/QWEN_MTP_BENCHMARK.md`](docs/QWEN_MTP_BENCHMARK.md) | методика и результаты Qwen MTP |
| [`docs/RELEASE_0.7.md`](docs/RELEASE_0.7.md) | изменения 0.7 |
| [`docs/RELEASE_0.6.md`](docs/RELEASE_0.6.md) | изменения 0.6 |
| [`docs/ROADMAP_0.6.md`](docs/ROADMAP_0.6.md) | согласованный roadmap |
| [`docs/ROADMAP_0.7.md`](docs/ROADMAP_0.7.md) | scope и beta-checklist 0.7 |
| [`docs/ENGINES.md`](docs/ENGINES.md) | llama.cpp/Ollama lifecycle |
| [`docs/BENCHMARK_0.6.md`](docs/BENCHMARK_0.6.md) | план benchmark TinyCode/OpenCode V2 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | слои и инварианты |
| [`docs/LOCAL_MODEL_EVALUATION.md`](docs/LOCAL_MODEL_EVALUATION.md) | ручные model measurements |
| [`promt.md`](promt.md) | системный prompt агента |
| [`compact.md`](compact.md) | prompt compaction |

## Лицензия

[MIT](LICENSE)
