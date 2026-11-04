# TinyCode 0.5

## Tools и repair

`ToolRegistry` управляет профилями и проверяет доступность перед исполнением.
`plan` — read-only; `edit` — чтение, запись и verify; `full` — все встроенные и
MCP tools. `auto` переключает stages plan → edit → verify. Исходная проверка
тестов доступна через `verify` уже в auto:plan, произвольный shell не открывается.
Явный запрос на shell/server/network может переводить auto в full; approval остаётся.

У каждого аргумента в промте сохраняются type, required, описание ≤60 символов,
enum и default. Ошибка JSON содержит конкретный фрагмент, схему известного tool
и пример. Для неизвестного имени не придумывается исполняемый tool.

`read_before_edit` применяется к edit/replace: только успешно возвращённые
файлы отмечаются прочитанными. Для старых сессий без readPaths используется
совместимый список успешных read calls. Это не песочница для произвольного shell:
в full пользователь по-прежнему разрешает выполнение команд.

Повторные failures имеют fingerprint и подсказку: например `**/*.test.js`
вместо повторного `*.test.js`. Детерминированный guard ограничивает циклы, но не
гарантирует правильного плана для любой модели.

## Проверки

`verify(mode=quick|full)` определяет Node package scripts, pytest, Cargo, Go и
.NET solution. quick запускает typecheck/tests, full добавляет lint/build.
Approval обязателен. Не обнаруженная проверка — явная ошибка, а не успех.

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
        "safe": false
      }
    }
  }
}
```

TinyCode подключает stdio JSON-RPC server, выполняет initialize/tools-list
(с пагинацией), регистрирует `mcp_<server>_<tool>`. По умолчанию вызовы требуют
approval; `safe=true` — явная доверенная настройка. Исполняются только серверы,
которые пользователь указал в конфиге. Ошибки подключения не ломают встроенные
tools. HTTP transports, resources и prompts пока отсутствуют.

## Sampling и observations

Профиль задаётся в `models[id].sampling.profile`, с fallback на
`generation.samplingProfile`. Числовые overrides применяются независимо от
семейства; больше нет проверки «temperature ровно 0.2».
`/no_think` добавляется к реальному user request для Qwen3 Off; HF hard-Off
workaround сохранён.

Older observation: до 5k head + 2k tail с отметкой пропуска. Последняя
observation полная, пока помещается в бюджет. Если сама observation больше
доступного окна, сохраняются начало и конец с явным предупреждением; неизвестную
середину нельзя считать проверенной.

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
Проверяются профили, read-before-edit, repair, sampling, latest observation,
verify, MCP discovery/call и syntax fallback. Model benchmarks только вручную.
