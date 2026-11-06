# Архитектура TinyCode

## 1. Задача

TinyCode — локальный terminal coding-agent для GGUF-моделей. Основной backend
новых установок — llama.cpp; Ollama остаётся альтернативным provider. Ядро отделено от TUI, а agent tools
используют простой текстовый протокол, понятный небольшим instruct-моделям.

Основные ограничения:

- один активный model request на процесс;
- tools выполняются последовательно;
- выполнение команд требует approval; остальные встроенные tools разрешены автоматически;
- tool calls не используют native Ollama function calling.

## 2. Слои

```text
CLI (src/cli.ts)
  ├─ interactive TinyCodeTui
  ├─ one-shot run
  ├─ models / sessions / doctor
  └─ dependency composition
             │
             ▼
ChatService (src/core/chat.ts)
  ├─ SessionStore
  ├─ ContextBuilder + SystemPrompt
  ├─ Provider facade (LocalEngines → llama.cpp / Ollama)
  ├─ ToolRegistry
  ├─ approval callback
  └─ typed Bus events
             │
             ▼
TUI
  Terminal → KeyParser → App → Screen
      mouse      state      diff renderer
```

Правила зависимостей:

- `core` не импортирует `tui` и не пишет в stdout;
- provider не знает про UI, sessions и tools;
- tools не знают про ANSI и provider;
- TUI не выполняет HTTP и файловые операции агента;
- approval передаётся в ядро callback-функцией.

### 2.1. Переключаемые локальные движки

`LocalEngines` держит `ProviderRegistry` и соответствующие `LocalRuntime`.
Provider и runtime переключаются одной операцией; ChatService не сохраняет
устаревший transport, а TUI читает текущий engine label. Смена провайдера
запрещена во время generation. `SessionMeta.provider` сохраняет routing при
resume; старые сессии и конфиги без поля остаются Ollama. Новые configs используют
llama.cpp без выбранного GGUF. `/models` показывает единый список с секциями
`*Ollama*` и `*llama.cpp*`; выбор модели одновременно переключает движок.

`GgufCatalog` читает bounded metadata без tensors и без сохранения tokenizer
arrays. Источники: configured aliases/directories, TinyCode/llama cache и
validated GGUF layers в manifests Ollama. Не выполняется ни download весов,
ни copying blobs, ни full-system scan.

`LlamaInstaller` сначала находит explicit/PATH/cached binary, иначе выбирает
официальные release assets под OS/arch/backend. Stable release может ссылаться
на binary build через `nightly-tag.txt`. Streaming size/SHA-256 validation,
archive-path/link validation и приватный staging предшествуют публикации.
Windows/Linux CUDA требует matching cudart. PATH, драйверы и global environment
не меняются; auto install выполняется только при actual model load.

`LlamaRuntime` владеет точным child `llama-server`, loopback bind и process-only
API key. При startup передаются explicit ctx/parallel/batch/GPU/cache settings,
`--offline`, `--no-context-shift`, `--no-warmup`; очищаются inherited `LLAMA_ARG_*`
и выключаются доступные server-agent/UI switches. External server допускается
только для matching model/context и никогда не останавливается.
При exit/engine switch own child освобождается. См. [ENGINES.md](ENGINES.md).

## 3. Model turn и agent-loop

```text
user input
  │
  ├─ persist user Message
  │
  └─ create one assistant Message
        │
        ├─ build context + system prompt
         ├─ stream selected provider
         │    ├─ reasoning → ReasoningPart
         │    └─ content   → TextPart / hidden tool buffer
        │
        ├─ parse <tool_call> JSON
        ├─ add ToolPart(pending)
        ├─ approval when safe=false (commands / restricted MCP)
        ├─ execute tool
        ├─ ToolPart(completed/error/denied)
        ├─ rebuild context with [Observation: ...]
        └─ repeat until normal final text / say / maxIterations
```

Весь user turn хранится одним assistant `Message`, но его `parts` идут в точном
порядке:

```ts
[
  { type: "reasoning", text: "..." },
  { type: "text", text: "I will read the file." },
  { type: "tool", tool: "read_file", status: "completed", ... },
  { type: "reasoning", text: "..." },
  { type: "text", text: "The bug is here..." }
]
```

Это позволяет TUI показывать один assistant turn, не смешивая thinking,
tool result и обычный ответ.

### 3.1. Scheduler, queue и goal review

`ChatService.pending` представляет один последовательный agent run. Новый
обычный ввод при active run не создаёт второй provider request: он атомарно
сохраняется в `SessionMeta.queuedInputs`. На следующей безопасной границе — после
завершённого model stream и соответствующего tool observation — очередь
переносится в ordered `SteeringPart`. `expandContext` разворачивает такой part в
user-role message между assistant/tool шагами. ID очереди предотвращает потерю
или дубль при crash между JSONL checkpoint и meta update. Поздний ввод после
последней boundary материализуется обычным user turn. Queue ограничена по числу
и общему размеру; параллельных model requests нет.

Активный `SessionMeta.goal` проверяется только после candidate final и пустой
очереди. Evaluator получает историю без agent tool prompt и не имеет project
tools; его единственные виртуальные verdict calls — `continue_work` и
`work_done`. `GoalReviewPart` хранит assessment/tool в transcript. Continue
разворачивается как user feedback для следующего model turn; work done удаляет
goal. Review repair и число continuations ограничены. TUI отображает review
свёрнутым и раскрывает его кликом. Evaluator usage входит в usage agent run.

## 4. Tool protocol

Модель получает определения tools, сгенерированные из `ToolRegistry`, и вызывает
ровно один tool следующим блоком:

```text
<tool_call>
{"name":"read_file","arguments":{"path":"src/index.ts"}}
</tool_call>
```

`ToolCallStreamFilter` работает во время стриминга:

- пропускает обычный assistant text в TUI;
- буферизует частично пришедший `<tool_call>`;
- скрывает JSON tool call от обычного ответа;
- корректно работает, если opening/closing tag разрезан между HTTP chunks.
- сохраняет quote/escape state между chunks: теги внутри JSON strings остаются
  скрытым file content, а не закрывают наружный tool block.

После полного turn `parseToolCalls` повторно разбирает raw text и валидирует:

- JSON object;
- непустое `name`;
- object в `arguments`;
- закрывающий tag.

Closing tags ищутся только вне JSON strings. Если Ollama strip-нул closing tag,
восстанавливается только полностью сбалансированный JSON object. Repair raw
newlines/invalid escapes и trailing commas не изменяет код внутри strings.

`streamTurn` возвращает raw text, stop reason, actual output cap и token counts.
Incomplete file-call с `length`/достигнутым cap получает `Truncated`, не generic
syntax feedback. До двух bounded retries удваивают per-turn output ceiling до
8192 или остатка `num_ctx`; `num_predict` не меняет runner allocation. Затем
даётся конкретный small skeleton/read/edit alternative. Неполный JSON не
исполняется, а повторное превышение после feedback завершает ход без цикла.
`lastContext.outputLimit/stopReason` сохраняют диагностику; config не переписывается.

Результат возвращается модели как user-role text:

```text
[Observation: File: src/index.ts (lines 1-40 of 40) ...]
```

При сборке контекста `ToolPart` разворачивается обратно в:

1. assistant message с `<tool_call>`;
2. user message с observation;
3. следующий assistant text.

## 5. Tools

Контракт:

```ts
interface Tool {
  definition: {
    name: string;
    description: string;
    parameters: JSONSchema;
    safe: boolean;
    summary(input): string;
  };
  run(input, { cwd, config, signal }): Promise<ToolResult>;
}
```

| Tool | Семантика |
| --- | --- |
| Чтение/поиск | `read_file`, `read_files`, `list_dir`, `find_files`, `search_text`, `file_info` |
| Изменение | `create_file`, `edit_file`, `apply_patch`, `replace_file` |
| Paths | `make_directory`, `move_path`, `copy_path`, `delete_file`, `delete_directory` |
| Git read-only | `git_status`, `git_diff`, `git_log`, `git_show` |
| Shell | `execute_command` |
| Processes | `start_process`, `process_status`, `list_processes`, `stop_process` |
| Network | `fetch_url` |
| User response | `say` |
| Verification | `verify`, `diagnostics` |

Файловая безопасность двухуровневая:

1. `resolveInCwd` блокирует абсолютный выход и `..`;
2. `assertRealPathInCwd` проверяет realpath существующего target или ближайшего
   существующего parent, блокируя symlink escape.

`apply_patch` использует двухфазный `git apply --check` → `git apply`. Managed
background processes хранятся в `ProcessManager` и завершаются при выходе.
Команды и проектные verification-скрипты требуют approval. Файловые операции,
сеть и остановка собственного managed-процесса разрешены автоматически.

## 6. Approval

`safe` означает автоматическое разрешение, а не доказанную безопасность.
Из встроенных tools `safe=false` только у `execute_command`, `start_process` и
`verify`: они исполняют команды или проектные скрипты. Все остальные встроенные
tools, включая edit/patch/replace/delete/move/copy/fetch/stop, имеют `safe=true`.

MCP-серверы получают `safe=true` по умолчанию при нормализации конфига. Явный
`safe=false` сохраняется и требует approval; сервер исполняет свой код вне
файловых ограничений TinyCode. Внутренний запуск команд MCP-инструментом не
определяется автоматически.

Профили проверяются отдельно, до approval. Автоматическое разрешение не обходит
`plan`/`auto`-ограничения или `read_before_edit` для edit/replace.

`core/tool-profile.ts` разрешает эффективный профиль из имени текущей модели.
При `profileByModel=true` и `profile=auto`: <20B → auto, ≥20B → full;
неизвестный размер → auto. Из MoE-имён берётся полный размер (`26B`), а `A4B`
игнорируется. Команда `/profile`/CLI flag с ручным выбором фиксирует профиль;
`model` восстанавливает дефолт. Профиль пересчитывается при выборе/возобновлении
модели без записи вычисленного значения в глобальный конфиг. TUI показывает
эффективный профиль сразу справа от процента контекста.

```ts
type ToolApprovalHandler =
  (request: { tool; summary; detail? }) => Promise<boolean>;
```

TUI устанавливает handler, который открывает modal dialog:

- `y` / `Enter`: allow once;
- `a`: allow all до завершения процесса;
- `n` / `Esc`: deny.

One-shot режим:

- с TTY спрашивает `[y/N]` через stderr;
- без TTY отклоняет команду или явно ограниченный MCP call и предлагает `--yes`;
- `--yes` или `tools.autoApprove` автоматически разрешает.

При deny ToolPart получает `status: "denied"`, а модель видит observation. Prompt
запрещает повторять тот же отклонённый вызов.

## 7. System prompt

`loadSystemPrompt` ищет:

1. `tools.promptFile`;
2. `TINYCODE_PROMPT`;
3. package-root `promt.md`;
4. package-root `prompt.md`;
5. built-in minimal fallback.

В template инъектируются:

- `<!-- TOOL DEFINITIONS PLACEHOLDER -->` или `{{TOOLS}}`;
- `{{CWD}}` непосредственно перед model request.

Tool descriptions и компактные argument schemas формируются из runtime registry, поэтому
prompt не расходится с реализацией. При `tools.enabled: false` system prompt не
добавляется и stream filter не скрывает `<tool_call>` text.

`project-instructions.ts` дополнительно подключает до 6k символов из
`AGENTS.md`, `TINYCODE.md`, `CLAUDE.md` и `.tinycode/instructions.md` в `cwd`.
Кэш сбрасывается после файловых/shell-изменений.

## 8. Контекст и полная история

`buildContext`:

1. сохраняет все uncompacted messages, в том числе failed/aborted work с отметкой статуса;
2. разворачивает ordered ToolParts в полные call/observation messages;
3. не возвращает reasoning модели повторно;
4. объединяет соседние роли для совместимого chat API;
5. проверяет бюджет и выдаёт `ContextOverflowError`, а не обрезает историю.

`expandContext` возвращает полную реконструкцию для оценки давления без
выбрасывания сообщений. Старые agent config `maxMessages`/`maxChars` больше не
применяются. Явный `maxChars` при прямом вызове builder служит только проверкой,
не алгоритмом выбора свежего хвоста.

`ChatService.contextBudget` дополнительно резервирует место внутри `num_ctx`:

```text
estimatedTokens(system + memory + full history) + adaptiveReplyReserve <= numCtx
```

Оценка использует UTF-8 bytes / 4 и overhead сообщений; точные счётчики берутся
из provider usage после ответа. Системный промт текущего профиля, existing memory и
адаптивный reserve входят в единый бюджет. `num_predict` — максимум, а не
обязательная бронь: перед request он уменьшается до доступного остатка. Ollama provider
передаёт `truncate:false` и `shift:false`, поэтому Ollama не должен скрыто
выбрасывать начало истории. `extraOptions.num_ctx/num_predict` не перекрывают
session values.

llama.cpp до inference получает весь request через `/apply-template` и
`/tokenize`: actual prompt count дополнительно проверяется против загруженного
per-slot `n_ctx`, `max_tokens` ограничивается точным остатком. Server context
shift отключён. Ошибка actual token budget останавливает запрос с указанием
`/compact`/`/context`, без скрытой обрезки.

`minimumContextSize` оценивает самый крупный системный prompt доступной стадии
(для auto: plan/edit/verify) плюс короткий ответ. TUI не отправляет сообщение с
заведомо меньшим окном, а снова открывает context picker.

## 8.1. Калькулятор памяти контекста

TUI не загружает веса при startup/new/model selection. `ChatService.send`
сначала сохраняет User message, затем вызывает cancellable `beforeGenerate`.
TUI использует готовую модель либо запускает llama-server / пустой Ollama load
с baseline `min(selected, 8192)`. `/props` (llama.cpp) или `/api/ps` (Ollama)
проверяет loaded context, после чего выбор приостанавливает generation.
Общий `runtime.ts` читает физическую RAM и, если доступен `nvidia-smi`, NVIDIA
VRAM. Remote/external server работает без allocation telemetry и помечается
`unknown`, а не RAM-only.

`context-memory.ts` совмещает runtime allocation с KV slope из GGUF / `/api/show`.
Плотные GQA-модели используют block/head/key/value metadata; Gemma 4 отдельно
учитывает глобальные растущие слои и capped sliding-window cache. Неизвестная
архитектура получает conservative heuristic и всегда помечается approximate.
Текущий `parallel` переводит общий runner context в per-slot context.

Результат различает model limit, memory estimate, GPU-only boundary и placement
`gpu|mixed|ram|unknown`. При mixed offload или RAM weights расчёт не падает и не
делает вывод, что вычисления идут только на CPU. `RAM ctx` означает лишь, что
model+KV не полностью VRAM-resident. До вычисления выбранного max оставляется
headroom RAM/VRAM. Значения выше memory estimate disabled в UI; custom override
остаётся явным действием пользователя.

Изменённый context помечается `{engine} restart required` в footer picker.
`applyContextValue` показывает `Restarting {engine}`, выгружает выбранный
Ollama runner / собственный llama-server и ждёт VRAM recovery. После загрузки выбранного размера
завершается `beforeGenerate`, и ответ начинается без дополнительной аллокации.
Изменение логического бюджета без изменения физического runner не используется.

`runnerContext` хранит известные load-sensitive options. Load/chat/compaction
повторяют один `shift:false`, `num_batch`, GPU/mmap/thread options и `num_ctx`.
Для TUI batch по умолчанию 256, чтобы загрузка и первый prefill имели одинаковые
параметры и ограниченные compute buffers.

При сбое unloading/OOM fallback рестартует локальный сервер не больше одного
раза на применение контекста. В llama.cpp допустим только собственный child;
в Ollama проверяются listener PID, executable/serve и
creation time; preserved bind/parallel/user settings передаются process-only.
Удалённый или непроверенный процесс не останавливается; другие модели того же
сервера при forced fallback могут быть выгружены. Перед повторным load VRAM
должна восстановиться до контрольного уровня. Ошибка откатывает предпочтение и
сохраняет исходный User message для `/retry`.

## 8.2. Сжатие сессии

Compaction не удаляет `messages.jsonl`. В `SessionMeta.compaction` хранятся:

```ts
{
  summary: string;
  throughMessageId: string;
  throughPartCount?: number; // exclusive cursor into an assistant tool loop
  sourceMessageCount: number;
  strategy: "model" | "fallback";
  model: string;
}
```

Алгоритм:

1. `contextUsageRatio` учитывает agent prompt, project instructions, existing
   memory, active messages и reserve под ответ.
2. `prepareContext` проверяет давление перед каждым model turn, включая шаги
   одного tool-loop. `planCompaction` сначала выбирает завершённые старые turns.
   Если их недостаточно, можно сжать завершённый префикс assistant parts.
   Минимальное число старых сообщений не блокирует сжатие под давлением.
3. Existing memory + выбранный transcript передаются отдельному `compact.md`
   без tools и reasoning.
4. Summary нормализуется, ограничивается по размеру и сохраняется с
   `throughMessageId` и, при checkpoint, `throughPartCount`.
5. `activeMessages` исключает покрытые summary turns из следующих model calls,
   а `<session_memory>` добавляется в system message.
6. Если summarizer не отвечает или падает, `fallbackSummary` детерминированно
    извлекает user goals, assistant results, file/tool actions, commands и errors.

Префикс обрывается только на завершённом tool boundary. Точный исходный user
request остаётся якорем. Новейший результат сохраняется полностью, кроме
emergency-compaction при переполнении: тогда весь его текст передаётся
summarizer. Источник сжатия не режется для помещения в окно; если подходящий
префикс не помещается, память не продвигается поверх непрочитанной середины.

До публикации partial cursor исходный JSONL переписывается атомарно. Финальная
запись обновляет checkpoint без дубликатов assistant ID. `activeMessages`
восстанавливает несжатый хвост при resume. Ошибка записи метаданных не меняет
in-memory cursor. Когда история не помещается и сжатие не помогает, вызов
provider отменяется с явным объяснением; raw history остаётся доступной.

Сжатие повторяемое: следующая итерация объединяет existing memory с новой
порцией истории. Доступны auto mode, `/compact` и CLI `tinycode compact`.

## 9. Streaming и parts

Ollama преобразует NDJSON, llama.cpp и compatible providers — SSE в:

```ts
{ type: "reasoning", text }
{ type: "text", text }
{ type: "done", usage, stopReason, outputLimit? }
```

Thinking никогда не добавляется в TextPart:

- TUI показывает `◇ thinking` с отдельной вертикальной направляющей;
- `/reasoning` скрывает/показывает блок;
- one-shot не пишет thinking в stdout;
- `--thinking` направляет его в stderr.

Usage суммируется между model turns одного agent-loop.
SSE parser сохраняет UTF-8 и multiline event state между chunks, получает usage
и timings; неожиданный обрыв stream считается ошибкой, не успешным финалом.
Native tool deltas реконструируются в прежний text protocol только после stream;
invalid/truncated arguments проходят bounded repair, а не исполняются частично.

## 10. TUI

Кадр — `Line[]`, где `Line = Span[]`. `Screen` сериализует spans в ANSI,
сравнивает с предыдущим кадром и перерисовывает только изменённые строки.

Состав кадра:

```text
header
divider
scrollable transcript / welcome CMD-art
composer
status/footer
modal picker или approval overlay
```

Стартовый экран выбирает по размеру терминала:

1. полный `TINY` + `CODE` CMD-art;
2. компактный `TINY`;
3. однострочный logo.

Quick Start, model, cwd, context и approval mode остаются видимыми настолько,
насколько позволяет высота.

Mouse mode включает SGR reports (`?1000h`, `?1006h`). `KeyParser` превращает
wheel button 64/65 в `wheelup`/`wheeldown`; приложение прокручивает transcript на
три строки. Up/Down по-прежнему управляют input history.

## 11. Сессии

```text
~/.tinytcode/
  config.json
  history.json
  sessions/ses_xxx/
    meta.json
    messages.jsonl
```

- meta записывается через temp + rename;
- JSONL дописывается после завершения assistant turn; partial-compaction создаёт
  атомарный checkpoint полного raw turn до сохранения cursor;
- malformed JSONL line пропускается;
- tool input/output/status сохраняются вместе с assistant message;
- compaction metadata и durable memory хранятся в `meta.json`, исходные turns
  остаются в JSONL;
- `/export` сериализует reasoning, tool arguments/output и final text в Markdown.

## 12. npm package

`package.json`:

```json
{
  "name": "tinycode-cli",
  "bin": { "tinycode": "dist/cli.js" },
  "files": ["dist", "promt.md", "compact.md", "README.md", "LICENSE", "docs"]
}
```

`dist/cli.js` сохраняет shebang. npm создаёт POSIX shim и Windows
`tinycode.cmd`. Package root содержит `promt.md`, а относительный URL из
`dist/core/prompt/system.js` корректно находит его после global install; то же
верно для `compact.md`.

Lifecycle:

- `prepublishOnly`: typecheck + smoke;
- `prepack`: build;
- package не включает `src`, `scripts`, `node_modules`.

## 13. Abort и ошибки

- один `AbortController` живёт на весь agent-loop;
- Esc отменяет model stream, approval или command;
- command process tree завершается (`taskkill /T /F` на Windows);
- timeout отличается от user abort;
- partial assistant message сохраняется с `aborted`;
- terminal state восстанавливается в `finally` и аварийном `exit` handler;
- mouse tracking всегда выключается при выходе.

## 14. Проверки

`npm run smoke` проверяет:

- Markdown/transcript/picker/welcome/approval layout на разных размерах;
- key parser, bracketed paste и SGR mouse wheel;
- editor/history;
- tool parser и split tags;
- context reconstruction;
- полный ChatService agent-loop с approval и вторым model turn;
- manual/automatic/model/fallback compaction;
- file/read/search/edit/patch/path/Git/network/process/say/command tools;
- cwd escape.

`npm run smoke:tui` запускает настоящий terminal lifecycle с mock Ollama:
welcome → `/help` → user prompt → `list_dir` → observation → final answer → quit.

Также проверяется `npm pack`, global install в временный prefix и запуск
`tinycode` из другой рабочей папки.

## 15. Следующие расширения

- project config `.tinycode.json`;
- granular permission rules (`allow npm test`, deny network commands);
- native tool calling для моделей, которые умеют его надёжно;
- syntax highlighting и structured diffs;
- расширение MCP transports/resources и LSP-навигации;
- локальный HTTP/SSE слой для web/desktop UI.
