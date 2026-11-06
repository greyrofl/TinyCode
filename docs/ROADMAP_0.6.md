# TinyCode 0.6 roadmap

## Agreed behavior

1. **Request queue.** Input submitted during an agent run is persisted FIFO.
   It enters model context after the current tool observation and before the
   next model request. No parallel branches or model requests.
2. **`/goal <task>`.** Candidate finals are reviewed by the active model by
   default. The evaluator emits only `continue_work` or `work_done`. Reviews
   are visible as Goal blocks; work_done clears the goal. Optional evaluator
   provider/model routing follows the generic-provider work.
3. **Verification policy.** `verify` remains available but is not mandatory
   after every edit. Explicit requested checks and claims that checks passed
   still require recorded evidence. Goal review decides whether other evidence
   is sufficient.
4. **Web search.** No-key DuckDuckGo search returns title/URL/snippet; selected
   sources are read with fetch_url. Failure/rate limits remain explicit.
5. **External providers.** User-declared OpenAI-compatible endpoints and models;
   context/thinking metadata is manual. TinyCode does not inspect memory,
   resize context or restart those servers.
6. **Markdown.** No renderer expansion: headings, emphasis, lists, quotes,
   links, inline/fenced code are already supported.
7. **Recommendations.** Rank a small built-in model catalog from total RAM/VRAM,
   weight and 32k KV estimates. Separate VRAM/hybrid/RAM. Install commands run
   only after command approval.
8. **Benchmark.** Design only in 0.6; see [BENCHMARK_0.6.md](BENCHMARK_0.6.md).

## Delivery slices

- [x] ordered queue, durable steering parts and queued TUI status;
- [x] active-model goal evaluator and verdict blocks;
- [x] relaxed verify responsibility with evidence guard;
- [x] no-key web_search tool;
- [x] initial OpenAI-compatible provider;
- [x] seed recommendation catalog and approval path;
- [x] benchmark specification;
- [x] evaluator provider/model override through the dynamic registry;
- [x] collapsible Goal Review interaction in TUI;
- [x] config/docs migration and 0.6 version bump.
