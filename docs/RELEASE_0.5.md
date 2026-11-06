# TinyCode 0.5

## Движки: llama.cpp-first

Новые configs используют прямой llama.cpp backend. Существующие configs и
сессии без `provider` продолжают работать через Ollama. `/models` показывает
сгруппированные секции Ollama/llama.cpp без отдельного шага `Change engine`;
`/provider` и CLI `--provider llama.cpp|ollama` дают явный выбор.
Provider сохраняется в session metadata; model defaults разделены по движкам.

`llama-server` находится через config/PATH/cache. При отсутствии можно скачать
официальный binary release в state TinyCode: OS/arch/backend assets выбираются
из metadata, проверяются size/SHA-256 и archive paths. CUDA получает matching
cudart. PATH/драйверы/глобальные настройки не меняются; weights не скачиваются.
GGUF metadata читаются без tensors/tokenizer arrays; Ollama cache используется
read-only, без копирования гигабайт.

Собственный llama-server запускается только после prompt, с explicit per-slot
context и без context shift/warmup/server agent. При смене context завершается
точный owned child и проверяется VRAM recovery. Чужой server можно reuse только
с matching model/context, но нельзя остановить или перенастроить. Его placement
остаётся unknown. На exit/engine switch own child освобождается.

SSE получает text/reasoning/usage/timings. Native tool deltas возвращаются в
существующий guarded text protocol. `/apply-template` + `/tokenize` проверяют
реальное число токенов всей истории до inference. Профили tools, compaction,
approval, checkpoints и repair остаются общими. См. [ENGINES.md](ENGINES.md).

## Tools и repair

`ToolRegistry` управляет профилями и проверяет доступность перед исполнением.
`plan` — read-only; `edit` — чтение, запись и verify; `full` — все встроенные и
MCP tools. `auto` переключает stages plan → edit → verify. Исходная проверка
тестов доступна через `verify` уже в auto:plan, произвольный shell не открывается.
Явный запрос на shell/server/network может переводить auto в full;
подтверждение выполнения команд остаётся.

Дефолт выбирается из имени текущей модели: <20B → `auto`, ≥20B → `full`.
`Gemma 26B A4B` считается 26B: активные MoE-параметры после `A` игнорируются.
Если полный размер не распознан, используется `auto`. Ручной `/profile` или
`--profile` имеет приоритет; `model` возвращает выбор по размеру.
Политика сохраняется через `tools.profileByModel`, вычисленный профиль не
перезаписывает конфиг при смене модели. Профиль виден в footer справа от процента
заполненности контекста, в том числе на узком терминале и во время генерации.

У каждого аргумента в промте сохраняются type, required, описание ≤60 символов,
enum и default. Ошибка JSON содержит конкретный фрагмент, схему известного tool
и пример. Для неизвестного имени не придумывается исполняемый tool.

Обрыв create/edit/replace/patch по output limit распознаётся отдельно. Есть до
двух per-turn повторов с увеличенным `num_predict` (до 8192 и остатка окна), затем
small complete skeleton/read/edit feedback. Незавершённые file calls никогда не
исполняются. Literal tool tags внутри `content` не закрывают внешний блок;
repair newline/trailing-comma не меняет байты содержимого. Output cap и stop
reason сохраняются в session diagnostics, persistent config не меняется.

`read_before_edit` применяется к edit/replace: только успешно возвращённые
файлы отмечаются прочитанными. Для старых сессий без readPaths используется
совместимый список успешных read calls. Это не песочница для произвольного shell:
в full пользователь по-прежнему разрешает выполнение команд.

Повторные failures имеют fingerprint и подсказку: например `**/*.test.js`
вместо повторного `*.test.js`. Детерминированный guard ограничивает циклы, но не
гарантирует правильного плана для любой модели.

## Подтверждения

Все встроенные файловые операции, включая delete/move/copy/patch, а также fetch
и остановка собственного managed-процесса разрешены автоматически.
Approval по умолчанию требуется только для `execute_command`, `start_process`
и `verify`: они запускают команды или код проекта. `--yes`/`tools.autoApprove`
сохраняют явное отключение этих запросов.

Это не расширяет профили и не отключает read-before-edit или файловые границы.
`safe=true` означает отсутствие запроса, а не безопасную песочницу.

## Проверки

`verify(mode=quick|full)` определяет Node package scripts, pytest, Cargo, Go и
.NET solution. quick запускает typecheck/tests, full добавляет lint/build.
По умолчанию требуется command approval. Не обнаруженная проверка — явная
ошибка, а не успех.

`diagnostics(path)` использует локально установленный language server:
typescript-language-server, pylsp, rust-analyzer или gopls. Поддерживаются
publishDiagnostics и pull diagnostics. Ответ привязан к URI файла и содержит
path/line/column/severity/source/code/message. Таймаут или отсутствие ответа
не считается чистой диагностикой.

Без LSP: Node syntax check, Python AST parse (без pycache), локальный TypeScript
compiler при наличии. Cargo/build-скрипты не запускаются молча как fallback.
Диагностика — отдельный tool, а не автоматически исполняемый тест после каждого
изменения; этап verify предлагает его агенту.

## MCP

Настраивается глобально:

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
        "safe": true
      }
    }
  }
}
```

TinyCode подключает stdio JSON-RPC server, выполняет initialize/tools-list
(с пагинацией), регистрирует `mcp_<server>_<tool>`. По умолчанию `safe=true` и
вызовы разрешены автоматически; явный `safe=false` требует approval.
Существующее явное ограничение не переписывается. Исполняются только серверы,
которые пользователь указал в конфиге. Ошибки подключения не ломают встроенные
tools. HTTP transports, resources и prompts пока отсутствуют.
MCP tools остаются доступны только в `full`. TinyCode не определяет, запускает
ли MCP-инструмент команды внутри сервера; подключайте только доверенные программы.

## Sampling и observations

Профиль задаётся в `models[id].sampling.profile`, с fallback на
`generation.samplingProfile`. Числовые overrides применяются независимо от
семейства; больше нет проверки «temperature ровно 0.2».
`/no_think` добавляется к реальному user request для Qwen3 Off; HF hard-Off
workaround сохранён.

До compaction передаётся вся активная история: user/assistant text, ошибки и
полные результаты tools. Старые message-count/24k-character ограничения не
применяются, unconditional head+tail убран. Reasoning остаётся только в UI/export.

Бюджет согласован с текущим `num_ctx`, системным промтом и резервом `num_predict`.
Автосжатие проверяется перед каждым запросом, включая шаги одного длинного
агентского хода. Завершённый tool-prefix может стать checkpoint; исходный запрос
и свежие результаты остаются активными. При emergency-compaction весь свежий
результат передаётся summarizer, если он помещается туда целиком.

JSONL сохраняет оригиналы, partial cursor восстанавливается при resume. Если
сжатие отключено, источник слишком большой или checkpoint нельзя безопасно
сохранить, история не обрезается молча: превышающий бюджет запрос не отправляется.
Токены оцениваются приблизительно; это не обещание безошибочной памяти модели.

Главный экран открывается без загрузки весов. После первого User message
появляется `Loading model {name}`; модель загружается без генерации с context
не выше 8192 (либо используется уже загруженная). Затем открывается memory-aware
context picker. `/api/ps` / llama.cpp buffers и `/props`, RAM, доступная
NVIDIA VRAM, KV metadata и parallel дают max estimate; model context limit
показывается как exact только когда оценка памяти до него доходит. Context,
который не полностью помещается в VRAM вместе с весами, отмечен `RAM ctx`.
Mixed offload, RAM weights и отсутствие GPU telemetry не являются ошибками.

Слишком маленькие варианты disabled с указанием minimum для активного tool
profile. `num_predict` трактуется как ceiling: reply reserve адаптивен, а лимит
каждого запроса уменьшается до остатка окна. `truncate:false`/`shift:false`
запрещают Ollama молча сдвигать историю; в llama.cpp передаётся `--no-context-shift`.
Изменённый context показывает `{engine} restart required`, после подтверждения —
`Restarting {engine}`. Runner сначала
выгружается, затем проверяется VRAM recovery; load нового размера и chat имеют
одинаковые `shift`/batch/runner options, без скрытой второй загрузки. Только
после применения размера начинается ответ на сохранённое сообщение.

Fallback может один раз перезапустить verified локальный server PID, не все
процессы Ollama по имени. Другие модели того же экземпляра при этом выгружаются;
remote/непроверенный процесс не завершается. Persistent настройки не меняются.
`Esc` отменяет setup/restart, `/retry` повторяет оригинал. Слишком большой размер
не загружается бесконечно повторно; пользователь должен выбрать меньший.

`tools.stopAfterToolCall=false` — экспериментальная stop sequence выключена.
При включении closing tag может не вернуться в stream, поэтому parser принимает
только полностью сбалансированный JSON. Реальный A/B не завершался: длительные
бенчмарки отключены по просьбе пользователя.

## Windows

Отключён detached startup для Windows: Node не создаёт отдельную консоль для
`ollama serve`, stdio игнорируется, процесс unref. PowerShell helper запускается
hidden. TinyCode не изменяет установленную Ollama или её runner binary; окна,
которые создаёт сама конкретная версия runner, требуют отдельной диагностики.

## Проверка изменений

Без генерации моделей: TypeScript typecheck и детерминированные smoke tests.
Проверяются профили, read-before-edit, repair, sampling, full-history до compaction,
in-turn checkpoints/resume/export, явный overflow, отказ summarizer/записи,
context capacity для GPU/mixed/RAM/unknown, deferred first-message flow,
controlled unload/VRAM/reload, bounded OOM fallback и cancel/retry, verify,
MCP discovery/call и syntax fallback. Новый engines-smoke дополнительно проверяет
installer/extractor, GGUF, SSE/native deltas, ownership, provider switching,
миграцию и настоящий CLI на mock HTTP. Model benchmarks только вручную.
