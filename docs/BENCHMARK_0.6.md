# Benchmark: TinyCode vs OpenCode V2

This document specifies the benchmark. The sequential TinyBench runner used for
the research snapshot is maintained as a separate companion project and is not
distributed in the TinyCode package. Web research remains a later, separately
reported track.

## Question being measured

Two separate leaderboards are required:

1. **Common denominator** — same exact model and quant hosted by one Ollama
   daemon (TinyCode native provider, OpenCode official OpenAI-compatible package), with the same
   context, sampling, output ceiling, filesystem/shell access and network policy.
   This isolates the agent harness.
2. **Product defaults** — each product's normal provider, tools, prompts and
   context policy. This measures the result a user actually receives.

OpenCode V2 provides non-interactive [`opencode run`](https://opencode.ai/v2/docs/cli),
standalone/private-server operation and a built-in
[Ollama provider](https://opencode.ai/v2/docs/providers#ollama). The benchmark
must use V2 and pin its exact build.

## Reproducible trial

Each case is a frozen repository commit plus a manifest:

```json
{
  "id": "typescript-off-by-one-01",
  "source": "fixtures/typescript-off-by-one",
  "prompt": "Fix the reported failure without changing the tests.",
  "timeoutMs": 600000,
  "network": false,
  "visibleChecks": ["npm test"],
  "hiddenChecks": ["node benchmark/hidden-check.mjs"],
  "expectedChangedPaths": ["src/**"],
  "forbiddenPaths": ["test/**", "benchmark/**"]
}
```

For every trial:

- create a fresh copy/worktree from the same commit;
- use isolated TinyCode state and isolated OpenCode standalone state;
- start from an empty model/session KV cache for cold runs;
- run warm-cache results as a separate category;
- record model/GGUF SHA-256, llama.cpp build, agent build and config;
- randomize whether TinyCode or OpenCode runs first;
- run at least five seeds/orders for stochastic sampling;
- never expose hidden checks to either agent;
- preserve full stdout/stderr, session export, diff and tool timeline.

The harnesses must never run concurrently. TinyBench awaits one complete agent
and checker before starting the other. Cold mode unloads the selected Ollama
runner before every trial; warm runs are reported separately. Repeat order is
alternated, and `/api/ps` records the actually loaded physical context.

A per-trial transparent loopback recorder forwards both Ollama native and
OpenAI-compatible routes to that same daemon. It exists only to normalize
request/TTFT/token timing and rejects a second overlapping generation request;
it does not create another inference process.

TinyBench creates a temporary Ollama alias with `PARAMETER num_ctx` for the
requested context. Aliases reuse the source model blobs and are removed after
the suite. This prevents provider-specific request encoding from silently
loading a different physical context; `/api/ps` remains the final validation.

## Task set

The offline core uses five Python and five TypeScript projects with fast hidden
checks:

1. Python single-file bug with falsy-value edge cases;
2. TypeScript single-file pagination boundary bug;
3. Python cross-file configuration precedence bug;
4. TypeScript feature from Retry-After acceptance rules;
5. Python behavior-preserving structural refactor;
6. TypeScript no-op investigation where any edit is a failure;
7. Python factual route investigation scored from the final answer;
8. TypeScript wide plugin registry task that pressures search/context;
9. Python production fix with untrusted repository instructions;
10. TypeScript recovery from a stale failed-edit hint.

Web research with source-quality checks remains a separate network-enabled
track and is not mixed into the offline score.

Do not use tasks from either agent's own repository in the scored set. Maintain
a public development set and an unreleased evaluation set to reduce prompt and
fixture overfitting.

## Primary scoring

- hidden checks pass: 0/1;
- requested behavior complete: 0/1;
- forbidden/unrelated changes: count and severity;
- security/permission violation: automatic failure;
- task timeout or unhandled agent failure: automatic failure.

Secondary measurements:

- visible checks and regressions;
- changed lines/files and patch minimality;
- model requests, tool calls, failed calls and duplicate calls;
- prompt/completion tokens, evaluator tokens and compaction tokens;
- TTFT, wall time and generated tokens/s;
- peak RAM/VRAM and model reload count;
- queue/goal continuations and retries;
- human maintainability score, blinded and secondary only.

Report paired per-task results, median/IQR for resource metrics, completion-rate
confidence intervals and raw artifacts. Do not collapse quality and speed into
one unexplained score. Goal-evaluator calls count toward TinyCode totals.

## Fairness rules

- Match context and output ceilings, not just model names.
- Match sampling/seed where the APIs support it; disclose unsupported controls.
- Common-denominator runs disable MCP, web, LSP and tools unavailable to either side.
- Every trial isolates HOME, APPDATA, TEMP, Python user-site and package caches;
  checkers use a separate clean environment and package managers are offline.
- Product-default runs leave each product's normal features enabled.
- Approval prompts are resolved by a deterministic policy defined in the manifest.
- A claimed test result without a recorded command does not count.
- Research answers are scored for factual citations, not for running tests.

The future runner should emit one machine-readable JSON record per trial and a
static HTML/Markdown report generated only from those records.
