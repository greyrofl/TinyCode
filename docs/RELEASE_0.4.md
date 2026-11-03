# TinyCode 0.4

## Agent loop

`promt.md` заменён компактным вариантом. В него по-прежнему подставляются 26
определений tools и project instructions. Больше нет специфичного примера с
готовым исправлением `cart.js`.

Файловые tools возвращают `changed/changedPaths`, diff и актуальные строки.
`edit_file` и `replace_file` отклоняют no-op без записи. Shell-команды сравнивают
metadata stamp рабочего дерева (без содержимого файлов); одинаковый успешный
test command не объявляется изменением проекта.

Три последовательных malformed/failed/unchanged действия останавливают loop.
Volatile tools (например process_status) не блокируются как кешированные чтения.
План без выполненного изменения или проверки получает корректирующую observation;
повторный неподтверждённый final становится `incomplete`, а реальный отказ — `blocked`.
Это проверка выполненных действий, не доказательство семантической корректности
любого кода. Для тестовой задачи требуется успешный check после последней правки.

## Model runtime preferences

`SessionMeta` хранит thinking/numCtx/lastContext. TUI дополнительно сохраняет
preferences в глобальном `models[modelId]`, без записи environment overrides.

`getModelDetails` читает `/api/show`: context limit, thinking values/default и
тип контроля. Именованные уровни никогда не угадываются. У модели с обязательным
reasoning Off отображается недоступным. Для модели без metadata и неизвестного
thinking-контроля предлагается только её default.

HF Go-template Qwen3, который безусловно добавляет `<think>`, обрабатывается
специально: Off строит ChatML с `<think>\n\n</think>` и вызывает локальный
`/api/generate` с `raw=true`. Это не создаёт/перезаписывает модель в Ollama.
Другие модели/режимы используют `/api/chat` и верхнеуровневый `think`.

`num_ctx` передаётся для каждого запроса. Менять его можно `/context`, через
picker или CLI `--context`. История на диске не удаляется. Контекстные бюджеты и
compaction учитывают выбранный размер сессии.

## Context footer

Внизу приоритет имеют `%` и `tokens/limit`. До финального NDJSON чанка значения
оценочные (`~`); затем берутся `prompt_eval_count + eval_count` последнего model
request. Это не суммарный расход токенов всех agent steps. После compaction или
смены режима/контекста старая метрика сбрасывается и пересчитывается оценка.

## Ollama startup / parallel

Перед сессией TinyCode проверяет `/api/version`. Для локального HTTP loopback,
при `autoStart=true`, запускает `ollama serve` и ждёт готовности. Установка и
скачивание моделей автоматически не выполняются. Внешние endpoints не запускаются.

Parallel берётся из последнего локального startup log или environment; источник
явно указан. Если значение неизвестно, TinyCode не выдаёт его за реальную настройку.
При обнаруженном значении !=1 появляется предупреждение и кликабельное действие.
По умолчанию выбран Keep, поэтому случайный Enter ничего не меняет.

Windows-кнопка сохраняет User environment и уведомляет Explorer. TinyCode не
меняет Machine environment и не завершает неизвестные Ollama processes. Сервер,
который запущен этим экземпляром TinyCode, можно безопасно перезапустить с одним
slot. Для уже существующего сервера сообщается необходимость полного restart.

## UI

Title-case CMD-art `TinyCode`, отдельный Session setup panel под логотипом,
явные поля model/thinking/context/folder/memory. Размер логотипа адаптируется к
терминалу. Model picker открывает thinking, затем context. Picker actions
поддерживают мышь; колесо остаётся скроллом чата.

## Verification

- Typecheck и весь прежний smoke suite.
- Новые feature tests: no-op, feedback, completion/repetition, concurrent send,
  early cancellation, mode/capability discovery, actual counters, persistence,
  clickable parallel action и managed/remote startup policy.
- Реальная Ollama: автоматический запуск отдельного сервера, HF Qwen3-8B Q4,
  Off, `num_ctx=4096`, ответ `4` на `2+2`; только TextPart, 2 generated tokens.
- В тестах Windows User/Machine environment не изменяется.
