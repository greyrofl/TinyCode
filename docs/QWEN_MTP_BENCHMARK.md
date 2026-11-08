# Qwen3.6 embedded MTP: локальные результаты

Дата: 2026-11-08. Это проверка совместимости и глубины draft на трёх задачах,
не полный model leaderboard и не итог 10-case suite.

## Условия

- Модель: [unsloth/Qwen3.6-35B-A3B-MTP-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF),
  `UD-IQ4_XS`, встроенная MTP-head (`qwen35moe.nextn_predict_layers=1`).
- NVIDIA RTX 3050 8 ГБ, Windows, Node.js 26.4.0.
- llama.cpp `b12110-win32-x64-cuda`; локальный Ollama 0.32.3 использован для
  обнаружения уже скачанных blobs, не для генерации.
- Context 32768; output ceiling 4096; target/draft KV `q8_0`; fit target 1536 MiB;
  `parallel=1`; без mmproj и отдельного sidecar.
- Thinking on; temperature 0.6; top-p 0.95; top-k 20; min-p 0;
  repeat penalty 1; seed 42; repeat 1; cold cache.
- Все trials выполнялись последовательно в изолированных offline workspaces.
- У всех пяти конфигураций одна замороженная сборка TinyCode с версией package
  `0.7.0` и предрелизной поддержкой Qwen, созданная **до финальных исправлений 0.7.1**.
- Snapshot: `tinycode-qwen-mtp-20261108T183957Z`.
- Build SHA-256: `65d453bd830254aed42bca861b4362acf82782856dd031d2fab25951babdd796`.

Скорость — сумма decode output tokens, делённая на сумму decode time из
`llama-server.log`. Время задачи включает startup, prompt processing, tools и
agent-loop. Acceptance — сумма принятых draft tokens / сумма предложенных.

## Полностью завершённые наборы

| Depth | Run ID | Hidden-check solved | Weighted tok/s | Acceptance | Total agent time | Median | False failure |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | `20261108T184255Z` | 3/3 | 27.28 | 85.9% | 392.7 с | 126.8 с | 1 |
| 3 | `20261108T184953Z` | 3/3 | 27.23 | 79.1% | 352.6 с | 118.7 с | 0 |

| Case | Hidden checks | x2 time | x3 time |
| --- | ---: | ---: | ---: |
| `py-cache-expiration` | 8/8 в обоих runs | 109.9 с | 109.4 с |
| `ts-pagination-boundary` | 7/7 в обоих runs | 126.8 с | 118.7 с |
| `ts-plugin-catalog-context` | 7/7 в обоих runs | 156.0 с | 124.6 с |

Peak system RAM / VRAM: x2 = 28.68 / 6.90 GiB, x3 = 27.91 / 6.91 GiB.
Это общая занятость памяти системы, не чистый расход одной модели.

### Ложный completion FAIL у x2

Plugin исправлен, visible и hidden checks прошли, запрещённых изменений нет.
Но агент вернул exit code 1 после 16 шагов: команда
`cd … && node --experimental-strip-types --test …` не была записана harness
как test evidence. Исправлено распознавание флага перед `--test` в 0.7.1.

Исторический `falseFailure=true` не удалён и время не пересчитано: исправление
не является повторным измерением этой задачи.

## Прерванные наборы: только Cache

| Depth | Run ID | Завершено trials | Cache checks | Cache tok/s | Acceptance | Cache time |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 4 | `20261108T185830Z` | 1/3 | 8/8 | 26.17 | 73.6% | 123.8 с |
| 6 | `20261108T185616Z` | 1/3 | 8/8 | 23.37 | 63.9% | 108.0 с |
| 16 | `20261108T190101Z` | 1/3 | 8/8 | 14.51 | 30.4% | 143.6 с |

Для Pagination/Plugin в этих runs нет завершённых checker summaries: их нельзя
засчитать как FAIL или использовать для сравнения полного времени набора.

## Вывод и ограничения

- x2 и x3 дают практически одинаковую decode speed. x3 завершил набор примерно
  на 10% быстрее за счёт другого, более короткого agent-loop.
- На Cache большие depths снизили throughput; высокий acceptance сам по себе
  не означает максимальную скорость.
- Для следующей проверки всего suite разумно начать с x3, сохранив x2 как
  консервативную альтернативу. Это предварительный выбор, не гарантия качества.
- Один seed, три задачи и отсутствие same-model no-draft control не позволяют
  заявить статистическую победу или процент ускорения MTP против Standard.
- Эти условия отличаются от прошлых Gemma runs: нельзя приписывать разницу
  одному лишь размеру модели или harness.

Данные: [`../data/qwen-mtp.json`](../data/qwen-mtp.json). В экспорт не включены
prompts, пользовательские пути, workspaces и веса.
