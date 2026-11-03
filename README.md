# TinyCode

Терминальный coding-agent для **маленьких локальных моделей (1–14B)** через
[Ollama](https://ollama.com). Интерфейс вдохновлён OpenCode, но имеет собственный
TUI: CMD-art логотип, потоковый чат, отдельные thinking/tool-блоки, сессии,
approval-диалоги и прокрутку колесом мыши.

TinyCode не использует облачные API и не содержит системы добавления удалённых
провайдеров. Модель и данные остаются локальными.

## Новое в 0.4

- Компактный основной промт вместо длинного повторяющегося протокола.
- Выбор модели → выбор поддерживаемого thinking → размер контекста.
- `/think off|on|auto|<level>` управляет генерацией; `/reasoning` — только видимостью.
- `/context <tokens>` передаёт `num_ctx` в Ollama и сохраняется для сессии.
- Нижняя панель показывает процент и `used/limit` токенов. `~` означает оценку
  во время стриминга; после ответа используются счётчики Ollama.
- При локальном запуске Ollama автоматически стартует, если ещё не работает.
- Предупреждение о parallel и кликабельная кнопка сохранения `parallel=1`.
- No-op edits не пишут файл; инструменты возвращают diff и текущие строки.
- Планы без действия/проверки больше не считаются завершённой задачей; серии
  ошибок и повторов прерываются раньше.

Для уже запущенной пользователем Ollama кнопка меняет Windows **User** environment,
но не останавливает сервер. Нужен его полный перезапуск. Сервер, запущенный
текущим TinyCode, перезапускается автоматически. На других ОС настройка применяется
к серверу, который запускает TinyCode; внешнюю службу следует настроить отдельно.

## Быстрый старт

Требования: Node.js **20.11+**, установленный и запущенный Ollama.

```bash
ollama serve
ollama pull qwen2.5-coder:7b
```

Из исходников:

```bash
npm install
npm run build
npm link

tinycode
```

После `npm link` команда `tinycode` работает из любой папки. Текущая папка
становится рабочим каталогом агента (`cwd`).

## Установка через npm

Да, проект готов собираться и запускаться как OpenCode. После публикации:

```bash
npm install --global tinycode-cli
tinycode
```

В рамках этой задачи пакет **не публиковался** в реестр: публикация требует
вашего npm-аккаунта. Локальный tarball и global install из него уже проверены.

Имя npm-пакета — **`tinycode-cli`**, а имя бинарника — **`tinycode`**. Пакет
`tinycode` в npm уже занят, поэтому они различаются. На Windows npm автоматически
создаёт `tinycode.cmd`.

Локально проверено:

- `npm pack` создаёт архив с `dist/`, `promt.md`, документацией и лицензией;
- установка архива через `npm install -g --prefix ...` создаёт `tinycode.cmd`;
- установленная команда запускается из другой папки и использует её как `cwd`.

Публикация владельцем пакета:

```bash
npm login
npm publish --access public
```

Перед публикацией автоматически запускаются typecheck, smoke-тесты и build.
Если имя `tinycode-cli` окажется занято до публикации, можно использовать scope,
например `@your-name/tinycode`; поле `bin` всё равно оставит команду `tinycode`.

## CLI

```text
tinycode [options]                 интерактивный TUI
tinycode run [options] [prompt]    one-shot; читает stdin без prompt
tinycode resume [session]          открыть сессию (последнюю по умолчанию)
tinycode compact [session]         сжать старые ходы в durable memory
tinycode models [--json]           модели Ollama
tinycode sessions [--json]         сохранённые сессии
tinycode config [--path|--json]    конфигурация
tinycode doctor                    диагностика Ollama, tools и prompt
```

Основные опции:

| Опция | Назначение |
| --- | --- |
| `-m, --model <name>` | модель для запуска |
| `-s, --session <id>` | конкретная сессия |
| `-c, --continue` | продолжить последнюю сессию |
| `--cwd <dir>` | рабочая папка агента |
| `-y, --yes` | автоматически разрешить опасные tools |
| `--thinking` | в `run` писать thinking в stderr |
| `--think <mode>` | реальный режим генерации thinking |
| `--context <n>` | контекст этой сессии в токенах |
| `--json` | JSON для `models`, `sessions`, `config` |

Примеры:

```bash
tinycode
tinycode --continue
tinycode run "объясни проект"
tinycode run --yes "запусти тесты и исправь ошибку"
tinycode run --thinking "проанализируй этот модуль"
echo "прочитай package.json" | tinycode run
```

В one-shot режиме stdout содержит только обычный ответ. Thinking выводится в
stderr только с `--thinking`; статусы tools и approval-предупреждения также идут
в stderr, поэтому stdout можно безопасно передавать дальше по pipe.

## Agent tools

Системный промт использует текстовый протокол:

```text
<tool_call>
{"name":"read_file","arguments":{"path":"src/index.ts"}}
</tool_call>
```

Это намеренно: небольшие instruct-модели обычно стабильнее генерируют такой
формат, чем native function calling. TinyCode скрывает raw `<tool_call>` из
ответа, выполняет действие, возвращает модели `[Observation: ...]` и продолжает
agent-loop до финального ответа.

Доступно **26 tools**:

| Группа | Tools |
| --- | --- |
| Чтение и поиск | `read_file`, `read_files`, `list_dir`, `find_files`, `search_text`, `file_info` |
| Изменение | `create_file`, `edit_file`, `apply_patch`, `replace_file` |
| Пути | `make_directory`, `move_path`, `copy_path`, `delete_file`, `delete_directory` |
| Git (read-only) | `git_status`, `git_diff`, `git_log`, `git_show` |
| Команды | `execute_command` |
| Background process | `start_process`, `process_status`, `list_processes`, `stop_process` |
| Сеть | `fetch_url` |
| Ответ | `say` |

Защита:

- файловые tools ограничены рабочей папкой;
- запрещены `..` и пути, уходящие наружу через symlink;
- `create_file` не перезаписывает существующий файл;
- `edit_file` делает точную замену и отказывается работать при неоднозначном
  совпадении;
- `apply_patch` сначала прогоняет `git apply --check`, затем применяет unified diff;
- `replace_file` остаётся инструментом полной замены;
- команды имеют timeout и лимит вывода;
- managed background processes автоматически останавливаются при выходе;
- все сетевые, изменяющие и потенциально разрушительные tools показывают approval;
- `y` — разрешить один раз, `a` — разрешить все опасные вызовы до выхода,
  `n`/`Esc` — отклонить;
- `tools.autoApprove: true` или `--yes` отключает запросы и требует осторожности.

## Системный промт

Тестовый промт находится в [`promt.md`](promt.md). Имя сохранено для
совместимости с исходным файлом пользователя.

При старте TinyCode:

1. читает `promt.md` (или кастомный файл);
2. автоматически заменяет `<!-- TOOL DEFINITIONS PLACEHOLDER -->` компактными
   актуальными схемами из `ToolRegistry`;
3. заменяет `{{CWD}}` на рабочую папку текущей сессии;
4. отправляет результат как `system` message только при включённых tools.

Основной промт теперь компактный и конкретный: read → act → observe → verify,
точная семантика `oldText/newText`, один валидный JSON-вызов за шаг, запрет
no-op/repeat, краткий фактический итог и защита пользовательских данных.

Промт задаёт приоритет инструкций, inspect→act→verify цикл, выбор tools,
защиту пользовательских изменений, работу с project instructions, compacted
memory, approvals и краткий формат финального ответа. `AGENTS.md`, `TINYCODE.md`,
`CLAUDE.md` и `.tinycode/instructions.md` из `cwd` подключаются автоматически.

Кастомный промт:

```json
{
  "tools": {
    "promptFile": "C:/prompts/my-agent.md"
  }
}
```

или переменная `TINYCODE_PROMPT`. Поддерживаются placeholders `{{CWD}}`,
`{{TOOLS}}` и `<!-- TOOL DEFINITIONS PLACEHOLDER -->`.

## TUI

Thinking, обычный ответ и tools хранятся как отдельные message parts и
отрисовываются отдельными блоками:

```text
◇ thinking
┊ краткое рассуждение модели

✔ read_file  done
  │ File: src/index.ts ...

Обычный финальный ответ модели.
```

Стартовый экран показывает CMD-art логотип, модель, `cwd`, бюджет контекста,
режим approval и понятные быстрые команды.

### Клавиши

| Клавиша | Действие |
| --- | --- |
| `Enter` | отправить сообщение |
| `Alt+Enter` / `Ctrl+J` | новая строка |
| `Tab` | дополнить slash-команду |
| `↑` / `↓` | история composer |
| колесо мыши | прокрутка чата |
| `Shift+↑` / `Shift+↓` | прокрутка на строку |
| `PgUp` / `PgDn` | прокрутка на страницу |
| `Esc` | отменить генерацию / очистить ввод / закрыть окно |
| `Ctrl+C` | отменить, очистить, затем выйти |
| `Ctrl+D` | выйти при пустом composer |
| `Ctrl+A` / `Ctrl+E` | начало / конец строки |
| `Ctrl+W` | удалить слово слева |
| `Ctrl+U` / `Ctrl+K` | удалить до начала / конца строки |
| `Ctrl+L` | полная перерисовка |

Колесо всегда прокручивает transcript. История введённых сообщений остаётся на
`↑`/`↓` и с колесом не связана.

### Slash-команды

| Команда | Действие |
| --- | --- |
| `/help` | commands, tools и клавиши |
| `/model [name]` | пикер или установка модели |
| `/new` | новая сессия |
| `/sessions` | открыть другую сессию |
| `/retry` | перегенерировать последний ответ |
| `/compact` | вручную сжать старые завершённые ходы |
| `/memory` | показать текущую compacted memory |
| `/tools` | показать все tools и уровень approval |
| `/reasoning` | показать/скрыть thinking |
| `/think [mode]` | выбрать реальный режим thinking модели |
| `/context [tokens]` | выбрать/задать context window Ollama |
| `/parallel` | проверить parallel и сохранить значение 1 |
| `/clear` | очистить экран, не удаляя сессию |
| `/export [path]` | Markdown с thinking и tool calls |
| `/info` | session/model/context/tools/prompt/config |
| `/quit`, `/exit` | выход |

## Конфигурация

Файл создаётся автоматически в `~/.tinytcode/config.json` (Windows:
`%USERPROFILE%\.tinytcode\config.json`).

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
    "thinking": "off"
  },
  "context": {
    "maxMessages": 24,
    "maxChars": 24000
  },
  "tools": {
    "enabled": true,
    "autoApprove": false,
    "maxIterations": 16,
    "commandTimeoutMs": 120000,
    "maxOutputChars": 24000,
    "promptFile": null,
    "maxStalledSteps": 3
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
  "ui": {
    "theme": "dark",
    "showReasoning": true,
    "showToolOutput": true,
    "mouse": true
  },
  "session": {
    "autoTitle": true
  }
}
```

Выбранные в TUI thinking/context сохраняются в `models[modelId]` как
`{ "thinking": "off", "numCtx": 8192 }`, а также в метаданных сессии. CLI-флаги
меняют только текущую сессию. Большой context требует больше KV-cache/VRAM и может
привести к перезагрузке модели или переносу слоёв на CPU.

Поддерживаемые уровни берутся из `/api/show`; уровни вроде low/medium/high не
придумываются по названию модели. Если Off не поддерживается, он недоступен в меню.
Для старого HF Go-template Qwen3 режим Off использует `/api/generate` с закрытым
thinking-префиксом ChatML: это отключает генерацию рассуждений, а не просто скрывает
поле ответа. В других режимах сохраняется обычный `/api/chat`.

Для Qwen3 на исходных общих sampling defaults автоматически используются
рекомендованные presets Off/On. Явные `ollama.extraOptions` имеют последний приоритет.
Автозапуск разрешён только для HTTP loopback URL; внешние серверы TinyCode не запускает.

TinyCode динамически уменьшает `context.maxChars`, если system prompt и резерв
под `numPredict` не помещаются в `numCtx`. При достижении `compaction.threshold`
старые завершённые ходы преобразуются в структурированную durable memory. Последние
`keepRecentMessages` остаются без изменений.

Переменные окружения:

- `TINYCODE_HOME` — каталог config/history/sessions;
- `TINYCODE_MODEL` — модель;
- `TINYCODE_OLLAMA_URL` или `OLLAMA_HOST` — Ollama;
- `TINYCODE_PROMPT` — файл системного промта.
- `TINYCODE_COMPACTION_PROMPT` — системный промт суммаризатора.

## Сжатие сессии

Алгоритм гибридный:

1. оценивает system prompt, текущую память, активные сообщения и резерв ответа;
2. при заполнении контекста выбирает только старые **завершённые** user/assistant
   turns, сохраняя свежий хвост;
3. передаёт существующую memory и выбранный transcript отдельному summarizer
   prompt из [`compact.md`](compact.md), без tools;
4. сохраняет структурированную Markdown memory в `meta.json` и отмечает
   `throughMessageId`;
5. следующие запросы получают memory в `<session_memory>`, а исходные старые
   сообщения остаются на диске и в UI, но больше не тратят context window;
6. при ошибке/пустом ответе модели применяется детерминированный extractive
   fallback, сохраняющий цели, file/tool actions, команды, ошибки и next step.

Повторное сжатие объединяет предыдущую memory с новой порцией истории. Запустить
вручную можно `/compact` или `tinycode compact [session]`.

## Хранение сессий

```text
~/.tinytcode/
  config.json
  history.json
  sessions/
    ses_xxx/
      meta.json
      messages.jsonl
```

Assistant message хранит ordered parts: `reasoning`, `text`, `tool`, следующий
`text`. Поэтому thinking, tool result и финальный ответ не смешиваются после
перезапуска или экспорта. Compacted memory хранится в `meta.json`; исходные
`messages.jsonl` не удаляются.

## Архитектура

```text
src/
  cli.ts                       argv, run, npm binary, doctor
  core/
    chat.ts                    agent-loop, approvals, compaction, abort/retry
    ollama-runtime.ts          безопасный local startup и parallel
    compaction.ts              план, context pressure, model/fallback summary
    context.ts                 system/user/tool context + trimming
    project-instructions.ts    AGENTS/TINYCODE/CLAUDE instructions
    prompt/                    agent + compaction prompts
    provider/model-details.ts  context/thinking capabilities и HF workaround
    provider/ollama.ts         Ollama NDJSON + thinking stream
    session/                   JSONL storage и Markdown export
    config/                    defaults, env overrides, persistence
    bus.ts                     typed UI events
  tools/
    registry.ts                реестр и определения
    parse.ts                   <tool_call> parser + stream filter
    file-tools.ts              базовые файловые операции
    advanced-file-tools.ts     edit/batch/path operations
    search-tools.ts            glob и content search
    patch-tool.ts              checked unified diff
    git-tools.ts               status/diff/log/show
    process-tools.ts           managed background processes
    fetch-tool.ts              HTTP/HTTPS text fetch
    command-tool.ts            cmd/shell с timeout
    say-tool.ts                обычное сообщение
    paths.ts                   cwd + symlink containment
    change-feedback.ts         no-op/verification/workspace stamp и diff preview
  tui/
    app.ts                     layout, input, scroll, approvals
    logo.ts                    CMD-art logo
    dialog.ts                  approval overlay
    transcript.ts              ordered thinking/text/tool parts
    terminal.ts / keys.ts      raw mode, wheel events, keyboard
    screen.ts                  diff renderer
    markdown.ts / picker.ts    presentation
```

Направление зависимостей: `CLI/TUI → ChatService → Provider/Tools/Session`.
Ядро не пишет ANSI и может позже использоваться сервером или desktop UI.

Подробнее: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Разработка и проверки

```bash
npm run typecheck
npm run build
npm run smoke
npm run mock
npm run smoke:tui
npm pack --dry-run
```

`npm run smoke` проверяет markdown/layout, CMD-art welcome, approval dialog,
mouse parser, context/tool protocol, полный agent-loop, ручное/автоматическое
сжатие, все файловые/search/git/network/process tools и cmd.
`smoke:tui` прогоняет настоящий `Terminal → KeyParser → TUI → tool → final`.

`scripts/features-smoke.ts` дополнительно проверяет model/thinking/context flow,
кликабельный parallel, отсутствие реальных Windows environment writes в тестах,
автозапуск/managed restart, Off/named modes, counters, cancellation и completion guard.

Реальную проверку установленной Ollama (без mock) можно повторить диагностическим
скриптом `node scripts/evaluate-models.mjs <profile>`. Он создаёт отдельную
песочницу, сохраняет запросы/ответы/метрики и не меняет ваш конфиг.
Подробный разбор результатов и ограничений —
[`docs/LOCAL_MODEL_EVALUATION.md`](docs/LOCAL_MODEL_EVALUATION.md).

## Текущие ограничения

- только Ollama;
- text-protocol tools вместо native function calling;
- нет MCP, LSP, проектного `.tinycode.json` и syntax highlighting;
- approval действует только до завершения текущего процесса;
- системный scrollback недоступен в alternate screen — используйте колесо,
  `PgUp/PgDn` или `/export`.

## Лицензия

MIT.
