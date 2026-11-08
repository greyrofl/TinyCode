# TinyCode 0.7

## Inference profiles

Model setup now continues from thinking mode into an inference picker. Managed
llama.cpp supports per-model **Standard**, **N-gram** and Gemma MTP profiles at
2x, 3x, 6x and 8x draft depth. The selected launch signature is persisted;
unchanged settings reuse the runner and changed settings perform one controlled
reload. MTP sidecars remain explicit local files and are never downloaded.

Draft GGUFs are discovered separately and no longer appear as target models.
External llama-server instances are never reconfigured by TinyCode.

## Workspace session tabs

Saved sessions from the current working directory appear as tabs in the top TUI
row. Closing a tab does not delete its history: the hidden state persists across
restarts and `/sessions` can explicitly reopen it. The `+` tab starts a new
session, while switching safely drains or aborts active setup/generation work.

## Responsive TUI

Pickers and approval dialogs now use semantic colors for statuses, placements
and profiles. Long descriptions and footer hints wrap within the dialog, while
the selected item receives a full metadata preview. Narrow headers and dialogs
remain within terminal width.

Usage under an answer is labelled **model traffic**: it accumulates all model
requests in one agent turn and reports the speed of the latest request. `/info`
separately exposes current compaction pressure and its automatic trigger.

## Recommendations and research data

`/recommend` now contains eight curated 8B–32B coding/agentic models. Placement
estimates account for weights, F16 KV, compute reserve and OS memory, and show a
preferred inference profile without downloading anything automatically.

`data/model-efficiency.json` contains a normalized, single-seed research
snapshot from 15 completed local runs. It excludes prompts, local paths and
weights and is not presented as a statistically stable leaderboard.

## Harness and runtime reliability

- managed llama.cpp launch arguments cover N-gram and MTP sidecar/device/cache
  settings, with capability checks and external-server refusal;
- Gemma's literal native quote control token (`<|"|>`) is normalized inside
  tool-call DSL without weakening incomplete-call rejection;
- Python verification distinguishes pytest projects from unittest fixtures;
- network tools can be disabled for isolated runs;
- anti-stall handling allows five consecutive failed/no-progress actions by
  default.

## Release verification

- `npm run typecheck`
- `npm run build`
- `npm run smoke`
- `npm run smoke:tui`
- `npm pack --dry-run`

All model/runtime tests use deterministic simulators. Model weights are not
downloaded by the release checks.
