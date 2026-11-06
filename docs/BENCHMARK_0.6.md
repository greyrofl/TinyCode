# Benchmark: TinyCode vs OpenCode V2

This document specifies the benchmark; 0.6 does not implement the runner yet.

## Question being measured

Two separate leaderboards are required:

1. **Common denominator** — same exact model, quant, OpenAI-compatible endpoint,
   context, sampling, output ceiling, filesystem/shell access and network policy.
   This isolates the agent harness.
2. **Product defaults** — each product's normal provider, tools, prompts and
   context policy. This measures the result a user actually receives.

OpenCode V2 provides non-interactive [`opencode run`](https://opencode.ai/v2/docs/cli),
standalone/private-server operation, and a declarative
[OpenAI-compatible custom provider](https://opencode.ai/v2/docs/providers#custom).
The benchmark must use V2 and pin its exact build.

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

The same endpoint must not serve both agents concurrently. Run sequentially,
reset the slot/cache according to the cold/warm category, and verify the loaded
physical context before every trial.

## Task set

Use small deterministic projects with fast hidden checks:

1. single-file bug with a visible failing test;
2. cross-file bug requiring search and data-flow understanding;
3. small feature from an acceptance specification;
4. refactor with behavior-preserving hidden tests;
5. broken build/type error in an unfamiliar stack;
6. project investigation with a factual written answer and no edits;
7. long tool loop that pressures context/compaction;
8. malformed/failed first edit requiring recovery;
9. web research with source-quality checks (separate network-enabled track).

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
- Product-default runs leave each product's normal features enabled.
- Approval prompts are resolved by a deterministic policy defined in the manifest.
- A claimed test result without a recorded command does not count.
- Research answers are scored for factual citations, not for running tests.

The future runner should emit one machine-readable JSON record per trial and a
static HTML/Markdown report generated only from those records.
