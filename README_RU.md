<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/greyrofl/TinyCode/main/docs/assets/tinycode-logo-dark.svg">
  <img src="https://raw.githubusercontent.com/greyrofl/TinyCode/main/docs/assets/tinycode-logo-light.svg" alt="TinyCode" width="470">
</picture>

### Легковесный local-first coding-агент для производительных GGUF-моделей

`llama.cpp` · `Ollama` · `OpenAI-compatible` · `GGUF` · `TUI`

[![npm](https://img.shields.io/npm/v/tinycode-cli?style=flat-square&logo=npm)](https://www.npmjs.com/package/tinycode-cli)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020.11-339933?style=flat-square&logo=node.js&logoColor=white)](#требования)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4b5563?style=flat-square)](#требования)
[![license](https://img.shields.io/badge/license-MIT-86efac?style=flat-square)](LICENSE)

[English](README.md) · [Релизы](https://github.com/greyrofl/TinyCode/releases) · [Документация](#документация)

</div>

TinyCode — экспериментальный терминальный coding-агент для локальных моделей.
Он управляет жизненным циклом модели, хранит сессии, выполняет защищённый agent
loop и предоставляет собственный TUI без тяжёлого UI-фреймворка.

TinyCode запускает локальные GGUF напрямую через управляемый
[llama.cpp](https://github.com/ggml-org/llama.cpp), работает с
[Ollama](https://ollama.com) и подключается к явно настроенным
OpenAI-compatible endpoints.

> **Local-first не означает «всегда offline».** Локальный inference — основной
> сценарий, но web tools и удалённые providers доступны при их использовании.
> Веса моделей никогда не скачиваются автоматически.

## Зачем TinyCode

TinyCode — не просто чат-обёртка над model server. Проект делает локального
coding-агента более предсказуемым:

- единый упорядоченный поток model/tool без скрытых параллельных веток;
- read-before-edit, защита от повторов и no-progress циклов;
- approval для команд, проверок и ограниченных MCP tools;
- durable sessions, очередь steering-сообщений, retry, export и compaction;
- явный context без скрытого отбрасывания истории;
- владение llama.cpp process, RAM/VRAM telemetry и controlled reload;
- отдельные thinking, sampling и inference profiles для каждой модели;
- встроенный Qwen MTP и Gemma MTP с sidecar;
- 29 встроенных инструментов плюс настроенные MCP tools.

«Tiny» означает легковесный агент и интерфейс. Это не обещание, что любая модель
меньше 8B способна надёжно решать repository-level задачи. Основная цель —
достаточно сильные локальные instruct/coding модели, обычно около 8B и больше.

## Требования

- Node.js **20.11+**;
- Windows, macOS или Linux;
- заранее скачанная локальная модель либо явно настроенный API endpoint.

TinyCode не скачивает веса. Для direct GGUF он может установить официальный
бинарный llama.cpp при первой загрузке модели с проверкой размера и SHA-256.
Автоустановка отключается через `llama.autoInstall: false`.

## Установка

```bash
npm install --global tinycode-cli
tinycode --version
```

Из исходников:

```bash
git clone https://github.com/greyrofl/TinyCode.git
cd TinyCode
npm ci
npm run build
npm link
```

## Быстрый старт

### Интерактивный выбор модели

```bash
cd /path/to/your/project
tinycode
```

Welcome screen не загружает веса. Откройте `/models`, выберите provider и модель,
затем thinking, inference profile и context. Загрузка начнётся только после
первого prompt.

### GGUF напрямую через llama.cpp

```bash
cd /path/to/your/project
tinycode --provider llama.cpp --model /path/to/model.gguf
```

TinyCode также ищет GGUF в:

- `~/.tinytcode/models`;
- `./models` текущего проекта;
- `LLAMA_CACHE` или `~/.cache/llama.cpp`;
- каталогах `llama.modelDirs`;
- локальном Ollama store без копирования blobs.

### Ollama

```bash
ollama pull qwen3:8b
cd /path/to/your/project
tinycode --provider ollama --model qwen3:8b
```

### One-shot режим

```bash
tinycode run --provider ollama --model qwen3:8b "Изучи проект и объясни его архитектуру"
```

Обычный ответ пишется в stdout. Статусы, reasoning, tools и approvals — в stderr.

## Inference profiles

Для управляемого TinyCode процесса llama.cpp команда `/inference` хранит профиль
отдельно для каждой модели:

| Профиль | Поведение |
| --- | --- |
| **Standard** | Только target model; максимальная совместимость |
| **N-gram** | Prompt lookup speculation без дополнительных весов |
| **MTP 2x/3x/6x/8x** | Model-specific глубина multi-token prediction |

Поддерживаются:

- **встроенный Qwen MTP** — определяется по `nextn_predict_layers`, sidecar не нужен;
- **Gemma MTP sidecar** — явно выбранный совместимый локальный draft GGUF.

Пример с уже скачанной Qwen MTP:

```bash
ollama pull "hf.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-IQ4_XS"
tinycode
```

Выберите запись `ollama-cache/...Qwen3.6...MTP...` в секции llama.cpp, затем MTP
2x или 3x. Встроенный MTP требует `parallel=1`, использует placement target model
и не загружает vision projector.

MTP depth — не гарантированный множитель скорости. Сравнивайте со Standard на
той же модели, кванте, context и hardware.

## Agent loop и инструменты

```text
user → model → tool call → guard/approval → local execution → observation → model
```

| Группа | Встроенные tools |
| --- | --- |
| Чтение/поиск | `read_file`, `read_files`, `list_dir`, `find_files`, `search_text`, `file_info` |
| Изменения | `create_file`, `replace_file`, `edit_file`, `apply_patch` |
| Пути | `make_directory`, `move_path`, `copy_path`, `delete_file`, `delete_directory` |
| Git | `git_status`, `git_diff`, `git_log`, `git_show` |
| Проверки | `diagnostics`, `verify` |
| Команды/процессы | `execute_command`, `start_process`, `process_status`, `list_processes`, `stop_process` |
| Интернет | `web_search`, `fetch_url` |
| Ответ | `say` |

File tools ограничены рабочей папкой и запрещают `..` и symlink escapes.
`execute_command`, `start_process`, `verify` и MCP tools с `safe: false` требуют
approval, если не указан `--yes`.

Tool profiles:

| Профиль | Доступ |
| --- | --- |
| `auto` | staged plan → edit → verify |
| `plan` | чтение, поиск, Git и diagnostics |
| `edit` | чтение, изменения и checks |
| `full` | все tools, включая shell, процессы, сеть и MCP |

Команды и MCP servers **не являются sandbox** и работают с правами текущего
пользователя ОС.

## Сессии и контекст

Состояние хранится в `~/.tinytcode`:

```text
config.json
history.json
engines/
models/
sessions/<session-id>/
  meta.json
  messages.jsonl
```

- сессии текущего workspace отображаются как persistent tabs;
- закрытие вкладки скрывает её, но не удаляет историю;
- ввод во время генерации ставится в очередь и применяется на ordered boundary;
- `/retry` повторяет последний запрос;
- `/compact` создаёт durable session memory;
- `/export` сохраняет Markdown.

До compaction используется вся активная история. TinyCode не выбирает скрытый
head/tail subset. Для llama.cpp точный prompt проверяется собственным template и
tokenizer модели; overflow отклоняется без скрытой truncation.

## Providers

| Возможность | llama.cpp | Ollama | OpenAI-compatible |
| --- | --- | --- | --- |
| Источник модели | локальный GGUF | локальная Ollama library | endpoint пользователя |
| Владение процессом | child TinyCode или внешний server | локальный daemon | внешний владелец |
| RAM/VRAM telemetry | managed runtime | `/api/ps` | нет |
| Physical context reload | controlled child restart | unload/reload runner | не управляется |
| Thinking | GGUF template и `/props` | `/api/show` | настраивается вручную |

Удалённые providers включаются явно. При их выборе prompts, история и tool
results покидают компьютер.

## Конфигурация

```text
~/.tinytcode/config.json
```

Минимальный direct GGUF:

```json
{
  "provider": "llama.cpp",
  "model": "coder",
  "llama": {
    "models": {
      "coder": "D:/models/coder-Q4_K_M.gguf"
    },
    "backend": "auto",
    "gpuLayers": "auto",
    "parallel": 1
  }
}
```

Минимальный OpenAI-compatible provider:

```json
{
  "provider": "local-api",
  "providers": {
    "local-api": {
      "type": "openai-compatible",
      "name": "My endpoint",
      "baseUrl": "http://127.0.0.1:9000/v1",
      "apiKeyEnv": "LOCAL_AI_KEY",
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

Храните credentials в environment variables из `apiKeyEnv`, а не в config.

## CLI

```text
tinycode [options]                 интерактивный TUI
tinycode run [options] [prompt]    one-shot; читает stdin из pipe
tinycode resume [session]          продолжить сессию
tinycode compact [session]         сжать старую историю
tinycode models [--json]           список моделей provider
tinycode tools [--json]            tools и approval levels
tinycode sessions [--json]         сохранённые сессии
tinycode config [--path|--json]    конфигурация
tinycode doctor                    диагностика provider и local state
```

Основные флаги:

```text
--provider <id>                    llama.cpp, ollama или configured provider
-m, --model <id>                   model id, alias или путь к GGUF
--context <tokens>                 physical context сессии
--think <mode>                     thinking mode
--inference <profile>              standard, ngram, mtp-2/3/6/8
--draft-model <path.gguf>          sidecar для совместимой MTP target model
--profile <name>                   model, auto, plan, edit, full
-y, --yes                          автоматически разрешать restricted tools
```

Полный список slash-команд доступен через `/help`.

## Рекомендации моделей

`/recommend` оценивает, помещаются ли curated coding-модели 8B–32B полностью в
VRAM, в hybrid VRAM/RAM или только в RAM при context не меньше 32K. Учитываются
weights, F16 KV, compute reserve и память ОС. Install command всё равно требует
approval.

Это оценка hardware, а не гарантия качества. Совместимость model/tool template
нужно проверять на реальных задачах.

## Данные бенчмарков

Репозиторий содержит нормализованные исследовательские данные, а не универсальный
leaderboard. Например, локальная проверка Qwen3.6-35B-A3B-MTP UD-IQ4_XS на RTX
3050 8 ГБ (32K context, один seed, три offline-задачи) дала:

| MTP depth | Hidden-check solved | Weighted decode | Acceptance |
| --- | ---: | ---: | ---: |
| 2 | 3/3 | 27.28 tok/s | 85.9% |
| 3 | 3/3 | 27.23 tok/s | 79.1% |

Это не полный suite, и matched no-draft control не запускался. Методика и
оговорки: [`docs/QWEN_MTP_BENCHMARK.md`](docs/QWEN_MTP_BENCHMARK.md),
[`data/qwen-mtp.json`](data/qwen-mtp.json),
[`data/model-efficiency.json`](data/model-efficiency.json).

## Приватность и безопасность

- веса моделей не скачиваются автоматически;
- local file tools остаются внутри workspace;
- незавершённые tool calls не исполняются;
- внешние providers получают данные только при их выборе;
- `web_search` и `fetch_url` используют сеть при вызове;
- commands и MCP tools не sandboxed;
- goal evaluator не является формальным доказательством корректности.

Проверяйте команды перед approval и подключайте только доверенные MCP servers.

## Разработка

```bash
npm ci
npm run typecheck
npm run build
npm run smoke
npm run smoke:tui
npm pack --dry-run
```

Smoke suite использует детерминированные симуляторы, не скачивает движки/веса и
не требует GPU.

## Документация

- [Архитектура](docs/ARCHITECTURE.md)
- [Жизненный цикл движков и inference](docs/ENGINES.md)
- [Методика Qwen MTP benchmark](docs/QWEN_MTP_BENCHMARK.md)
- [Заметки по локальным моделям](docs/LOCAL_MODEL_EVALUATION.md)
- [Спецификация benchmark](docs/BENCHMARK_0.6.md)
- [Release notes](https://github.com/greyrofl/TinyCode/releases)

Issues и compatibility reports приветствуются. Указывайте ОС, hardware, модель и
quant, provider/runtime, context и безопасные фрагменты логов без секретов.

## Лицензия

[MIT](LICENSE)
