# TinyCode 0.6

## Agent scheduler and queue

Normal input submitted while an agent run is active is persisted as FIFO queue
data instead of being rejected. Queue items enter model context only at ordered
checkpoints: after the current model stream and, when present, after its tool
observation. They are represented as durable steering parts, rendered as queued
user messages, included in compaction/export, and never create parallel model
or filesystem branches. Late queue input starts a following turn automatically.
Pending queue entries are rendered as quiet gray rows at the transcript bottom;
routine context/queue notices no longer create a panel above the composer.

## Goal evaluator

`/goal <task>` stores a session goal. A candidate final is reviewed without
project tools by an evaluator that returns exactly one virtual verdict tool:
`continue_work` or `work_done`. Continue feedback becomes user-role context for
the next main-agent step. Work done accepts the final and removes the goal.
Review blocks are collapsed by default in TUI, expandable by click, and exported
as Markdown details. The active model is default; `goal.provider`/`goal.model`
can route review through another configured provider. Continuations are bounded.

## Completion and verification

`verify` remains available and approval-gated but is no longer mandatory after
every edit. Explicit user requests for tests/checks still require a recorded
verification action. TinyCode also rejects claims such as “tests passed” when
no matching successful action exists. Goal evaluation handles other questions
of sufficiency and respects requests not to test or tasks where tests are not
meaningful.

## Search and providers

`web_search` uses DuckDuckGo's no-key HTML endpoint with bounded results,
timeouts, throttling, short cache, HTML sanitization and explicit challenge/
rate-limit failures. Snippets are untrusted; `fetch_url` reads selected sources.

User-defined `openai-compatible` providers declare endpoint, env credential,
models, context and thinking controls. Their servers are user-owned: TinyCode
does not inspect memory, load/unload models, resize physical context or restart
them. OpenAI SSE content/reasoning/usage/native tool deltas use the same guarded
agent loop. Provider sections appear in the grouped models picker.

## Model recommendations

`/recommend` evaluates a small seed catalog against total RAM/VRAM, quantized
weight size and a minimum 32k KV estimate. Results are grouped into VRAM-only,
hybrid and RAM-only categories. Selecting an entry asks normal command approval
before running its catalog install command. 0.6 initially includes Qwen2.5-Coder
7B Q4_K_M and Gemma 4 26B A4B UD-Q4_K_M as functional sample entries.

Direct llama.cpp startup now expires the matching selected Ollama runner even
when TinyCode starts with llama.cpp already selected. This prevents duplicate
Gemma allocations. Windows defaults mirror the useful Ollama characteristics:
non-mmap load mode, batch/ubatch 256 and a 512 MiB fit target.

## Markdown and benchmark

No new Markdown syntax was added: TinyCode already renders headings, emphasis,
lists, quotes, links and inline/fenced code. Goal Review is a separate UI block.

The TinyCode/OpenCode V2 benchmark is specified, not implemented, in
[BENCHMARK_0.6.md](BENCHMARK_0.6.md). The accepted roadmap is in
[ROADMAP_0.6.md](ROADMAP_0.6.md).
