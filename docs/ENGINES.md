# Движки TinyCode

## Выбор и совместимость

Новая установка использует `provider: "llama.cpp"`. Существующий конфиг без
`provider` остаётся Ollama; сессия без `SessionMeta.provider` также всегда
восстанавливается через Ollama. Конфиг и веса Ollama не конвертируются/переносятся.

- `/models`: единый фильтруемый список с секциями `*Ollama*` и `*llama.cpp*`;
  выбранная модель одновременно выбирает свой движок.
- `/model [name]`: совместимое меню текущего движка / прямой выбор.
- `/provider llama.cpp` или `/provider ollama`: сменить движок и открыть модели.
- `--provider llama.cpp|ollama`: override только текущего запуска/сессии.

`providerModels` хранит последнюю модель каждого движка. История сессии при смене
провайдера не удаляется; для новой независимой переписки используйте `/new`.
Настройки context/thinking/sampling разделены ключами `llama.cpp::<model>` и
старыми Ollama model ids в `models`.

В ветке 0.7 к model preference добавлен inference profile. После выбора модели
TUI предлагает `Standard`, `N-gram` и Gemma MTP с глубиной 2/3/6/8. Изменение
профиля не загружает веса сразу: managed llama-server получает новую launch
signature при следующем prompt. Совпадающая signature переиспользует runner,
отличающаяся вызывает один controlled reload.

MTP sidecar ищется отдельно от selectable target-моделей. Он должен быть
локальным совместимым GGUF; TinyCode не скачивает его. Чужой llama-server не
перенастраивается inference-профилем — параметры задаёт его владелец.

При смене Ollama → llama.cpp TinyCode выгружает только выбранный Ollama runner и
ждёт освобождения VRAM. Сам daemon и другие загруженные в нём модели не
останавливаются. При обратной смене завершается только owned llama-server.

## Модели llama.cpp

Нужен уже скачанный GGUF instruct-модели с подходящим chat template. Пример:

```json
{
  "provider": "llama.cpp",
  "model": "gemma-4-26B-A4B",
  "llama": {
    "modelDirs": ["D:/models"],
    "models": {
      "gemma-4-26B-A4B": "D:/models/gemma-4-26B-A4B-it-Q4_K_M.gguf"
    }
  }
}
```

Также можно передать полный путь через `--model` или `/model`. В TUI пробелы
после `/model` являются частью пути; обрамляющие кавычки не требуются.
Автопоиск ограничен каталогами `~/.tinytcode/models`, `./models`, `LLAMA_CACHE`
(по умолчанию `~/.cache/llama.cpp`) и `llama.modelDirs`; всю систему он не сканирует.
Из split GGUF показывается только первый shard; остальные должны лежать рядом.
Отдельные `mmproj` не считаются языковыми моделями. Пока поддерживается текстовый
чат, не мультимодальный ввод.

Из локальных manifests Ollama выбирается только model layer с GGUF magic.
Такие модели отображаются как `ollama-cache/<model>:<tag>` и читаются прямо из
`blobs`, без копирования гигабайт. Не каждый Ollama blob содержит самостоятельный
chat template или поддерживаемую llama.cpp архитектуру: для него может
понадобиться исходный GGUF нужной сборки. Веса никогда не скачиваются автоматически.

## Установка самого движка

При первой загрузке модели:

1. `llama.executable` / `TINYCODE_LLAMA_EXECUTABLE`, если задан.
2. Установленный `llama-server` / `llama-server.exe` из PATH.
3. Уже проверенная установка в `~/.tinytcode/engines/llama.cpp`.
4. Если `autoInstall:true`, официальный релиз `ggml-org/llama.cpp` с GitHub.

`release: "latest"` разрешается через stable release и его `nightly-tag.txt`,
если бинарники опубликованы отдельно. Можно явно зафиксировать `bNNNNN`.
Скачивание потоковое, с лимитом размера, точной проверкой size и SHA-256 из
release metadata. Без digest установка запрещена. Archive paths и symlink targets
проверяются до распаковки; установка публикуется только после проверки бинарника.
Отмена/неверная checksum оставляет старую установку, не публикуя новую.
Уже установленная версия переиспользуется; автоматического обновления при
каждом запуске нет. Для обновления укажите другой release tag.

Поддержаны официальные CPU/Vulkan бинарники Windows и Linux x64/arm64, macOS
x64/arm64, а также совместимые CUDA сборки из релиза. `auto` выбирает CUDA при
совместимом NVIDIA driver, Metal на macOS, иначе CPU; AMD/Intel Vulkan задаётся
явно. CUDA скачивается вместе с matching cudart; это сотни MiB. Для распаковки
нужен системный `tar`. Драйверы и PATH не меняются, sudo/admin не используются.
Если официального бинарника для комбинации нет, задайте `llama.executable`.

Для автоматического offload установленный server должен поддерживать
`--gpu-layers auto`. Слишком старый бинарник отклоняется до загрузки весов:
обновите llama.cpp или настройте явный `gpuLayers` для совместимой версии.
Ошибочный явный путь не вызывает скрытого скачивания взамен него.

## Процесс, память и генерация

Welcome screen и выбор модели не загружают веса. Первое сообщение сохраняется;
затем TinyCode запускает собственный server с context, сохранённым для модели
(в пределах model limit), измеряет buffers и `/props`, открывает context picker.
При OOM сервер один раз перезапускается с 8192, размер сохраняется и capacity
пересчитывается. Неизменный context переиспользуется; изменение требует
остановки точного child PID, ожидания VRAM и нового server.
Новый `--ctx-size` проверяется как per-slot `n_ctx`; `parallel` по умолчанию 1.

Для своего server TinyCode задаёт loopback bind, случайный process-only API key,
`--offline`, `--no-context-shift`, `--no-warmup`. Унаследованные `LLAMA_ARG_*`
очищаются: скрытые model download, tools, MCP и tunnel не включаются. Доступные
server-side agent/UI switches выключаются. Инструменты и approval исполняет
только TinyCode, не встроенный агент llama-server.

`gpuLayers`, `cpuMoe`, `kvOffload`, cache types, batch и threads задаются в
`llama`. Это не гарантирует размещение любого контекста: OOM остаётся возможным.
На Windows default `loadMode:none` не удерживает весь mmap GGUF в working set;
`fitTargetMiB:512` позволяет использовать больше VRAM, а batch/ubatch 256
соответствуют базовой конфигурации Ollama. Перед direct llama.cpp load TinyCode
выгружает matching выбранный Ollama runner даже после нового запуска, чтобы одна
и та же многогигабайтная модель не занимала RAM/VRAM дважды.
При failed startup допускается один cleanup/retry, затем предпочтение
откатывается и prompt сохраняется. `Esc` отменяет setup, `/retry` повторяет prompt.
Выход и смена движка освобождают только собственный llama-server.

Чужой сервер на `llama.baseUrl` допускается только для уже загруженных matching
model/context. Его нельзя остановить/перенастроить автоматически, даже если он
локальный. Для другого context укажите отдельный свободный loopback-порт.
Внешний server без allocation telemetry помечается `unknown`, не как CPU-only.

Перед каждым completion вся активная история проходит `/apply-template` и
`/tokenize`. `max_tokens` ограничен настоящим остатком окна. Переполнение
отклоняется без truncation. SSE разбирает `content`, `reasoning_content`, usage,
timings и stop reason. Native tool deltas, если их вернул template parser,
собираются в прежний текстовый tool protocol и проходят те же guards/approval.
Незавершённый stream/call не исполняется. Compaction, resume и export общие для
обоих движков.

## Проверка

`scripts/engines-smoke.ts` проверяет установку/отмену/checksum, настоящий tar
extractor на маленьком архиве, GGUF metadata, streaming, tool deltas, ownership,
VRAM/reload, bounded OOM, engine picker, миграцию и настоящий CLI на mock HTTP.
Ни бинарные релизы, ни веса не скачиваются этими тестами. Реальная скорость и
совместимость конкретного GGUF проверяются пользователем вручную.
