# Архитектура TinyCode

## 1. Задача

TinyCode — локальный terminal coding-agent для моделей 1–14B. В текущей версии
Ollama является единственным provider. Ядро отделено от TUI, а agent tools
используют простой текстовый протокол, понятный небольшим instruct-моделям.

Основные ограничения:

- один активный model request на процесс;
- tools выполняются последовательно;
- опасные действия требуют approval;
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
  ├─ Provider (Ollama)
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

## 3. Model turn и agent-loop

```text
user input
  │
  ├─ persist user Message
  │
  └─ create one assistant Message
        │
        ├─ build context + system prompt
        ├─ stream Ollama
        │    ├─ message.thinking → ReasoningPart
        │    └─ message.content  → TextPart / hidden tool buffer
        │
        ├─ parse <tool_call> JSON
        ├─ add ToolPart(pending)
        ├─ approval when unsafe
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

После полного turn `parseToolCalls` повторно разбирает raw text и валидирует:

- JSON object;
- непустое `name`;
- object в `arguments`;
- закрывающий tag.

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
Shell, network и изменяющие/destructive tools требуют approval.

## 6. Approval

Unsafe tools включают edit/patch/replace/delete/move/copy, shell, network и
start/stop process. Read/search/Git-inspection выполняются автоматически.

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
- без TTY отклоняет unsafe call и предлагает `--yes`;
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

## 8. Контекст маленьких моделей

`buildContext`:

1. исключает failed/aborted messages;
2. выбирает newest messages по `maxMessages` и `maxChars`;
3. разворачивает ordered ToolParts в call/observation messages;
4. не возвращает reasoning модели повторно;
5. при слишком длинном текущем agent turn оставляет исходный user request и
   наиболее свежие tool exchanges;
6. объединяет соседние роли для Ollama.

`ChatService.contextBudget` дополнительно резервирует место внутри `num_ctx`:

```text
conversation chars <=
  (numCtx - outputReserve) * 4 - systemPrompt.length
```

`outputReserve` ограничен половиной контекста. Это предотвращает ситуацию,
когда длинный system prompt + 24k истории вытесняют генерацию.

## 8.1. Сжатие сессии

Compaction не удаляет `messages.jsonl`. В `SessionMeta.compaction` хранятся:

```ts
{
  summary: string;
  throughMessageId: string;
  sourceMessageCount: number;
  strategy: "model" | "fallback";
  model: string;
}
```

Алгоритм:

1. `contextUsageRatio` учитывает agent prompt, project instructions, existing
   memory, active messages и reserve под ответ.
2. При превышении threshold `planCompaction` группирует старые сообщения в
   завершённые user/assistant turns и всегда оставляет свежий хвост.
3. Existing memory + выбранный transcript передаются отдельному `compact.md`
   без tools и reasoning.
4. Summary нормализуется, ограничивается по размеру и сохраняется с
   `throughMessageId`.
5. `activeMessages` исключает покрытые summary turns из следующих model calls,
   а `<session_memory>` добавляется в system message.
6. Если summarizer не отвечает или падает, `fallbackSummary` детерминированно
   извлекает user goals, assistant results, file/tool actions, commands и errors.

Сжатие повторяемое: следующая итерация объединяет existing memory с новой
порцией истории. Доступны auto mode, `/compact` и CLI `tinycode compact`.

## 9. Streaming и parts

Ollama provider преобразует NDJSON в:

```ts
{ type: "reasoning", text }
{ type: "text", text }
{ type: "done", usage, stopReason }
```

Thinking никогда не добавляется в TextPart:

- TUI показывает `◇ thinking` с отдельной вертикальной направляющей;
- `/reasoning` скрывает/показывает блок;
- one-shot не пишет thinking в stdout;
- `--thinking` направляет его в stderr.

Usage суммируется между model turns одного agent-loop.

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
- JSONL дописывается после завершения assistant turn;
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
