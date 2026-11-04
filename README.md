<div align="center">

<pre>
█████ ███ █   █ █   █  ████  ███  ████  █████
  █    █  ██  █ █   █ █     █   █ █   █ █
  █    █  █ █ █  █ █  █     █   █ █   █ ████
  █    █  █  ██   █   █     █   █ █   █ █
  █   ███ █   █   █    ████  ███  ████  █████
</pre>

### Терминальный coding-агент для маленьких локальных моделей

`Ollama` · `1–14B` · `без облака` · `TUI`

[![version](https://img.shields.io/badge/version-0.5.0-7dd3fc?style=flat-square)](#что-нового-в-05)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020.11-339933?style=flat-square&logo=node.js&logoColor=white)](#быстрый-старт)
[![ollama](https://img.shields.io/badge/Ollama-local-111827?style=flat-square)](https://ollama.com)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4b5563?style=flat-square)](#быстрый-старт)
[![license](https://img.shields.io/badge/license-MIT-86efac?style=flat-square)](LICENSE)

</div>

TinyCode — агент для терминала, который работает с моделями **1–14B** через
[Ollama](https://ollama.com) (а при достаточной VRAM — и с более крупными).
Никаких облачных API: модель, файлы и сессии остаются на вашей машине.
Интерфейс вдохновлён OpenCode, но TUI, агентский цикл и протокол инструментов
написаны с нуля под ограничения маленьких моделей.

```
$ ollama pull qwen2.5-coder:7b
$ cd my-project
$ tinycode
```

---

## Почему TinyCode

- **Текстовый протокол вместо native function calling.** Модели 1–14B заметно
  стабильнее выдают `<tool_call>{"name":...}</tool_call>`, чем JSON-schema
  function calling. Парсер при этом умеет чинить типичные ошибки JSON.
- **Проверяется результат, а не обещание.** «Сейчас исправлю» без изменения файла
  не считается выполнением. Финал принимается только после фактического действия
  и проверки.
- **Маленькая модель не обязана быть самостоятельной.** Промт, stage-профили
  tools, `read_before_edit`, fingerprint повторных ошибок и `verify` берут на себя
  ту дисциплину, которой у 7B обычно не хватает.
- **Рассчитан на один GPU.** Один parallel slot, `num_ctx` под сессию, честные
  счётчики токенов и предупреждение, если Ollama вытесняет слои в CPU.

## Содержание

- [Быстрый старт](#быстрый-старт)
- [Что нового в 0.5](#что-нового-в-05)
- [Возможности](#возможности)
- [Tools](#tools)
- [CLI](#cli)
- [TUI](#tui)
- [Конфигурация](#конфигурация)
- [Модели и железо](#модели-и-железо)
- [Архитектура](#архитектура)
- [Разработка](#разработка)
- [Ограничения](#ограничения)
- [Документация](#документация)

---

## Быстрый старт

Нужны **Node.js 20.11+** и установленный [Ollama](https://ollama.com). Если
Ollama слушает loopback и ещё не запущена, TinyCode поднимет её сам; внешние
серверы он не стартует.

```bash
# 1. модель
ollama pull qwen2.5-coder:7b

# 2. сам агент
git clone https://github.com/greyrofl/TinyCode.git
cd TinyCode
npm install
npm run build
npm link

# 3. работа
cd ~/projects/my-app
tinycode
```

После `npm link` команда `tinycode` доступна из любой папки, а текущая папка
становится рабочим каталогом агента.

> **npm-пакет.** Имя пакета — `tinycode-cli`, бинарника — `tinycode` (имя
> `tinycode` в npm занято). Пакет подготовлен к публикации, но в реестр пока не
> выложен. После публикации установка будет такой:
>
> ```bash
> npm install --global tinycode-cli
> ```

## Что нового в 0.5

- **Профили tools**: `/profile auto|plan|edit|full` и `--profile`. `auto` ведёт
  агента по этапам plan → edit → verify, а не выдаёт сразу все 28 инструментов.
- **`verify`** сам определяет стек (npm scripts, pytest, Cargo, Go, .NET) и
  запускает проверки. Не найденная проверка — ошибка, а не «всё хорошо».
- **`diagnostics`** использует локальный LSP (`typescript-language-server`,
  `pylsp`, `rust-analyzer`, `gopls`) либо syntax fallback. Молчание LSP не
  считается отсутствием ошибок.
- **`read_before_edit`**: `edit_file` и `replace_file` требуют успешного чтения
  этого файла в сессии.
- **Repair**: ошибка JSON показывает фрагмент, схему конкретного tool и валидный
  пример; повторная ошибка получает подсказку о следующем действии.
- **MCP**: локальные stdio-серверы из конфига, tools вида
  `mcp_<server>_<tool>`, по умолчанию с approval.
- **Sampling profiles** вместо неявного выбора по числам temperature/topP.
- **Observations**: старые сокращаются head+tail, свежая сохраняется целиком,
  если помещается в бюджет.
- **Windows**: автозапуск Ollama больше не создаёт отдельную detached-консоль.

Подробно, включая компромиссы и то, что осталось выключенным:
[`docs/RELEASE_0.5.md`](docs/RELEASE_0.5.md).

---

## Возможности

### Агентский цикл

```
read → act → observe → verify → answer
```

Модель вызывает один инструмент за шаг, получает `[Observation: ...]` и
продолжает до финального ответа. TinyCode:

- скрывает служебные `<tool_call>` из ленты;
- блокирует no-op правки и повторные неизменные вызовы;
- останавливает серию malformed/failed шагов;
- не принимает план вместо действия;
- возвращает модели diff и актуальные строки после правки;
- прямо запрещает править тесты, чтобы скрыть падение.

### Профили tools

| Профиль | Что доступно | Когда использовать |
| --- | --- | --- |
| `auto` | чтение всегда; запись после чтения; verify после правки | по умолчанию |
| `plan` | только чтение, git, поиск, `verify` для исходных тестов | анализ и планирование |
| `edit` | чтение + запись + verify | обычная правка кода |
| `full` | всё, включая shell, process и MCP tools | shell/server/network задачи |

Переключение: `/profile` в TUI или `--profile full` в CLI. Approval при этом
никуда не исчезает.

### Проверка результата

`verify(mode=quick|full)` находит проект и запускает его проверки:

- Node: package scripts (`typecheck`, `test`, `lint`, `build`) через npm, pnpm
  или yarn;
- Python: pytest;
- Rust: Cargo;
- Go: `go test`;
- .NET: solution.

`quick` — typecheck/tests, `full` — ещё lint/build. `diagnostics(path)` даёт
ошибки компилятора/линтера с `path:line:column` и не выдаёт отсутствие LSP за
чистый результат.

### Контекст и память

При приближении к лимиту старые завершённые ходы сжимаются в структурированную
Markdown-память. Свежие сообщения остаются нетронутыми, исходные
`messages.jsonl` не удаляются. Если модель не смогла суммаризировать, включается
детерминированный extractive fallback.

Внизу экрана — реальные токены последнего запроса; `~` означает оценку во время
стриминга. После compaction, смены модели или контекста метрика пересчитывается.

### Сессии

```text
~/.tinytcode/
  config.json
  history.json
  sessions/
    ses_xxx/
      meta.json        # модель, контекст, thinking, compacted memory
      messages.jsonl   # ordered parts: reasoning / text / tool
```

Сессию можно продолжить (`--continue`, `tinycode resume`), экспортировать в
Markdown (`/export`) или сжать вручную (`/compact`).

---

## Tools

28 встроенных инструментов плюс подключённые MCP-серверы.

| Группа | Инструменты |
| --- | --- |
| Чтение и поиск | `read_file`, `read_files`, `list_dir`, `find_files`, `search_text`, `file_info` |
| Изменение | `create_file`, `edit_file`, `apply_patch`, `replace_file` |
| Пути | `make_directory`, `move_path`, `copy_path`, `delete_file`, `delete_directory` |
| Git (read-only) | `git_status`, `git_diff`, `git_log`, `git_show` |
| Проверка | `verify`, `diagnostics` |
| Команды | `execute_command` |
| Фоновые процессы | `start_process`, `process_status`, `list_processes`, `stop_process` |
| Сеть | `fetch_url` |
| Ответ | `say` |

**Защита**

- файловые операции ограничены рабочей папкой, `..` и symlink-выходы запрещены;
- `create_file` не перезаписывает существующий файл;
- `edit_file` делает точную замену и отказывается при неоднозначном совпадении;
- `apply_patch` сначала выполняет `git apply --check`;
- у команд есть timeout и лимит вывода;
- managed-процессы останавливаются при выходе;
- сеть, запись, удаление и shell требуют approval: `y` — один раз, `a` — до
  конца сессии, `n`/`Esc` — отказ;
- `--yes` / `tools.autoApprove` отключают запросы — используйте осознанно.

Протокол вызова:

```text
<tool_call>
{"name":"read_file","arguments":{"path":"src/index.ts"}}
</tool_call>
```

---

## CLI

```text
tinycode [options]                 интерактивный TUI
tinycode run [options] [prompt]    one-shot; читает stdin, если есть pipe
tinycode resume [session]          открыть сессию (последнюю по умолчанию)
tinycode compact [session]         сжать старые ходы в durable memory
tinycode models [--json]           модели Ollama
tinycode tools [--json]            tools и уровень approval
tinycode sessions [--json]         сохранённые сессии
tinycode config [--path|--json]    конфигурация
tinycode doctor                    диагностика Ollama, tools и prompt
```

| Опция | Назначение |
| --- | --- |
| `-m, --model <name>` | модель для запуска |
| `-s, --session <id>` | конкретная сессия |
| `-c, --continue` | продолжить последнюю сессию |
| `--cwd <dir>` | рабочая папка агента |
| `-y, --yes` | автоматически разрешить опасные tools |
| `--thinking` | в `run` писать thinking в stderr |
| `--think <mode>` | реальный режим thinking: `off`, `on`, `auto` или named level |
| `--context <n>` | размер контекста этой сессии (`num_ctx`) |
| `--profile <name>` | `auto`, `plan`, `edit`, `full` |
| `--json` | machine-readable вывод для `models`/`sessions`/`config` |

В one-shot режиме stdout содержит только обычный ответ: thinking, статусы tools и
approval-предупреждения идут в stderr, поэтому `tinycode run ... > patch.md`
безопасен.

```bash
tinycode run "объясни структуру проекта"
tinycode run --yes "запусти тесты и исправь падение"
tinycode run --thinking "проанализируй этот модуль"
echo "прочитай package.json" | tinycode run
```

---

## TUI

Thinking, ответ и tool-вызовы — отдельные блоки, поэтому после перезапуска и
экспорта они не смешиваются:

```text
◇ thinking
┊ краткое рассуждение модели

✔ read_file  done
  │ File: src/index.ts ...

✔ edit_file  done
  │ - return items[index];
  │ + return items[index - 1];

Проверил: typecheck и 3 теста проходят.
```

Стартовый экран показывает блочный wordmark с градиентом, строку
`local models · real code · N tools` и карточку сессии: model, thinking, context,
folder с подсказками slash-команд.

<details>
<summary><b>Клавиши</b></summary>

| Клавиша | Действие |
| --- | --- |
| `Enter` | отправить |
| `Alt+Enter` / `Ctrl+J` | новая строка |
| `Tab` | дополнить slash-команду |
| `↑` / `↓` | история composer |
| колесо | прокрутка чата |
| `Shift+↑` / `Shift+↓` | прокрутка на строку |
| `PgUp` / `PgDn` | прокрутка на страницу |
| `Esc` | отменить генерацию / очистить ввод / закрыть |
| `Ctrl+C` | отменить, очистить, затем выйти |
| `Ctrl+D` | выйти при пустом composer |
| `Ctrl+A` / `Ctrl+E` | начало / конец строки |
| `Ctrl+W` | удалить слово слева |
| `Ctrl+U` / `Ctrl+K` | удалить до начала / конца строки |
| `Ctrl+L` | полная перерисовка |

</details>

<details>
<summary><b>Slash-команды</b></summary>

| Команда | Действие |
| --- | --- |
| `/help` | команды, tools и клавиши |
| `/model [name]` | пикер или установка модели |
| `/new` | новая сессия |
| `/sessions` | переключить сессию |
| `/retry` | перегенерировать последний ответ |
| `/compact` | сжать старые ходы |
| `/memory` | показать compacted memory |
| `/tools` | tools и уровень approval |
| `/reasoning` | показать/скрыть thinking |
| `/think [mode]` | режим генерации thinking |
| `/context [tokens]` | context window Ollama |
| `/profile <name>` | `auto`, `plan`, `edit`, `full` |
| `/parallel` | проверить parallel и сохранить `1` |
| `/clear` | очистить экран без потери сессии |
| `/export [path]` | Markdown с thinking и tool calls |
| `/info` | session/model/context/tools/prompt/config |
| `/quit`, `/exit` | выход |

</details>

---

## Конфигурация

Файл создаётся автоматически:

```text
~/.tinytcode/config.json            # Windows: %USERPROFILE%\.tinytcode\config.json
```

<details>
<summary><b>Полный конфиг по умолчанию</b></summary>

```json
{
  "model": "qwen2.5-coder:7b",
  "models": {},
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434",
    "timeoutMs": 600000,
    "keepAlive": "5m",
    "headers": {},
    "extraOptions": {},
    "autoStart": true,
    "startupTimeoutMs": 20000,
    "parallel": null
  },
  "generation": {
    "temperature": 0.2,
    "topP": 0.9,
    "numCtx": 8192,
    "numPredict": 2048,
    "repeatPenalty": 1.05,
    "seed": null,
    "stop": [],
    "thinking": "off",
    "samplingProfile": "auto"
  },
  "context": { "maxMessages": 24, "maxChars": 24000 },
  "tools": {
    "enabled": true,
    "autoApprove": false,
    "maxIterations": 16,
    "commandTimeoutMs": 120000,
    "maxOutputChars": 24000,
    "promptFile": null,
    "maxStalledSteps": 3,
    "profile": "auto",
    "stopAfterToolCall": false
  },
  "compaction": {
    "enabled": true,
    "auto": true,
    "threshold": 0.72,
    "keepRecentMessages": 6,
    "minMessages": 10,
    "maxSummaryChars": 6000,
    "numPredict": 1024,
    "promptFile": null
  },
  "ui": { "theme": "dark", "showReasoning": true, "showToolOutput": true, "mouse": true },
  "session": { "autoTitle": true },
  "mcp": { "enabled": true, "servers": {} }
}
```

</details>

### Профили моделей и sampling

Выбор в TUI сохраняется в `models[modelId]` и в метаданных сессии. CLI-флаги
меняют только текущую сессию.

```json
{
  "models": {
    "hf.co/Qwen/Qwen3-8B-GGUF:Q4_K_M": {
      "thinking": "off",
      "numCtx": 8192,
      "sampling": {
        "profile": "qwen3-fast",
        "temperature": 0.7,
        "topP": 0.8,
        "topK": 20
      }
    }
  }
}
```

Доступные профили: `auto`, `model`, `qwen3-thinking`, `qwen3-fast`, `custom`.
`model` берёт defaults из `/api/show`, `auto` — рекомендованные Qwen3 presets
для Off/On, для остальных — объявленные моделью значения. Явные параметры
`models[id].sampling` перекрывают профиль, а `ollama.extraOptions` применяются
последними и перекрывают всё остальное.

Уровни thinking не угадываются: только то, что объявила модель. Если Off не
поддерживается, он недоступен в меню.

### MCP

```json
{
  "mcp": {
    "enabled": true,
    "servers": {
      "local": {
        "enabled": true,
        "command": "node",
        "args": ["C:/mcp/server.mjs"],
        "env": {},
        "safe": false
      }
    }
  }
}
```

Поддерживаются stdio JSON-RPC серверы и их tools. HTTP transports, resources и
prompts пока нет. `safe: true` отключает approval только для явно доверенного
сервера.

### Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `TINYCODE_HOME` | каталог config/history/sessions |
| `TINYCODE_MODEL` | модель по умолчанию |
| `TINYCODE_OLLAMA_URL` / `OLLAMA_HOST` | адрес Ollama |
| `TINYCODE_PROMPT` | файл системного промта |
| `TINYCODE_COMPACTION_PROMPT` | промт суммаризатора |

---

## Модели и железо

TinyCode создан под небольшие модели и один GPU. Ориентиры для **8 ГБ VRAM**
(например, RTX 3050), `parallel=1`:

| Модель | Q4 вес | Помещается | Ожидаемо |
| --- | ---: | --- | --- |
| Qwen3-8B Q4_K_M | 5.0 ГБ | целиком | ~28 tok/s, рабочий дефолт |
| Qwen3-14B Q4_K_M | 9.3 ГБ | частично | ~5–10 tok/s, тяжёлые задачи |
| 27B Q4 | 16–17 ГБ | нет | только удалённый Ollama или 24 ГБ VRAM |

Цифры — ориентиры, а не гарантия: скорость зависит от контекста, кванта и
свободной VRAM. Большой `num_ctx` увеличивает KV-cache и может вытеснить слои в
CPU; TinyCode предупредит об этом.

Практическое правило: **8B Q4 решает однофайловые баги с падающим тестом**,
14B заметно лучше держит многошаговый план, 27B локально почти не окупается —
каждый шаг агента занимает минуты. Подробный разбор и замеры:
[`docs/LOCAL_MODEL_EVALUATION.md`](docs/LOCAL_MODEL_EVALUATION.md).

---

## Архитектура

```text
src/
  cli.ts                     argv, run/resume/compact/models/tools/doctor
  core/
    chat.ts                  agent loop, approvals, compaction, abort/retry
    context.ts               system/user/tool context + trimming
    compaction.ts            план сжатия, context pressure, fallback summary
    task-guard.ts            completion / plan / blocked detection
    ollama-runtime.ts        локальный старт и parallel
    provider/                Ollama NDJSON, model capabilities, HF workaround
    prompt/                  agent и compaction prompts
    session/                 JSONL storage, память, экспорт
    config/                  defaults, env, persistence, sampling
    bus.ts                   типизированные события UI
  tools/
    registry.ts              реестр, профили и стадии
    parse.ts                 <tool_call> parser + stream filter
    file-tools.ts            базовые файловые операции
    advanced-file-tools.ts   edit/batch/path
    search-tools.ts          glob и content search
    patch-tool.ts            checked unified diff
    verify-tool.ts           детект стека и запуск проверок
    lsp-tool.ts              LSP diagnostics / syntax fallback
    process-tools.ts         managed background processes
    ...
  mcp/                       клиент локальных stdio-серверов
  tui/
    app.ts                   layout, ввод, scroll, approvals
    logo.ts                  wordmark с градиентом
    transcript.ts            ordered reasoning/text/tool parts
    ...
```

Направление зависимостей: `CLI/TUI → ChatService → Provider / Tools / Session`.
Ядро не печатает ANSI, поэтому его можно использовать в другом фронтенде.

Подробнее: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Разработка

```bash
npm run typecheck     # tsc --noEmit
npm run build         # dist/
npm run smoke         # layout + agent loop + tools
npm run smoke:tui     # Terminal → KeyParser → TUI → tool → answer
npm run mock          # mock Ollama на localhost
npm pack --dry-run    # содержимое npm-пакета
```

Smoke-набор детерминированный и не вызывает реальные модели. Он проверяет
профили и стадии tools, read-before-edit, repair, sampling, обрезку observations,
`verify`, MCP discovery/call, syntax fallback, approval-диалог, контекст и
completion guard.

Реальный прогон на установленной Ollama:

```bash
node scripts/evaluate-models.mjs <profile> [seconds]
```

Скрипт создаёт отдельную песочницу и сохраняет запросы, ответы и метрики, не
трогая ваш конфиг.

---

## Ограничения

- только Ollama, без других провайдеров;
- текстовый протокол tools вместо native function calling;
- MCP — только stdio/tools, без HTTP, resources и prompts;
- LSP требует установленного language server; syntax fallback не заменяет его
  полностью;
- нет проектного `.tinycode.json` и syntax highlighting;
- approval действует до завершения процесса;
- alternate screen скрывает системный scrollback — используйте колесо,
  `PgUp/PgDn` или `/export`;
- harness проверяет действия и запускает проверки, но не доказывает семантическую
  корректность любого кода.

---

## Документация

| Документ | О чём |
| --- | --- |
| [`docs/RELEASE_0.5.md`](docs/RELEASE_0.5.md) | что изменилось в 0.5 и что осталось выключенным |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | слои, потоки данных, инварианты |
| [`docs/LOCAL_MODEL_EVALUATION.md`](docs/LOCAL_MODEL_EVALUATION.md) | замеры на реальных моделях и выводы |
| [`promt.md`](promt.md) | системный промт агента |
| [`compact.md`](compact.md) | промт суммаризации сессии |

---

## Лицензия

[MIT](LICENSE).

<div align="center">

Сделано для тех, у кого 8 ГБ VRAM и много терпения.

</div>
