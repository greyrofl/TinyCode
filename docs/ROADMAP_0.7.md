# TinyCode 0.7 roadmap

## Release theme

TinyCode 0.7 targets capable local coding models (approximately 8B+), with the
primary optimized path built around Gemma 4 and managed llama.cpp. It does not
attempt to turn sub-8B models into reliable repository agents.

## Implemented scope

- [x] Per-model inference profiles: Standard, N-gram, MTP 2x/3x/6x/8x.
- [x] Model setup flow: model → thinking → inference; no weights load until the
  first prompt.
- [x] Gemma-only MTP guard in the normal UI, local sidecar discovery and explicit
  path fallback. TinyCode never downloads a target or draft GGUF.
- [x] Runtime launch signatures: changing inference depth reloads an owned
  llama-server exactly once; unchanged profiles reuse it.
- [x] Workspace session tabs in the top TUI row. Closing a tab preserves the
  saved session and persists its hidden state across restarts; explicitly
  resuming it reopens the tab. `+` starts a new session and `/sessions` remains
  the full archive.
- [x] Responsive picker/dialog layout with semantic status colors, wrapped
  descriptions and footers, and a full selected-item detail preview.
- [x] Expanded 8B–32B recommendation catalog with F16 KV, OS and compute-memory
  estimates, placement and preferred inference profile.
- [x] Machine-readable efficiency research snapshot generated from existing
  TinyBench runs under `data/model-efficiency.json`.

## Non-goals

- No automatic GGUF or MTP sidecar downloads.
- No special harness mode for very small models.
- No publication of the efficiency data on the website before methodology and
  repeated-run validation are accepted.
- No npm publication as part of the GitHub release.
- TinyBench source and generated benchmark/model artifacts remain outside the
  TinyCode repository.

## 0.7.0 release validation

- [x] Deterministic runtime tests for Standard/N-gram/MTP argv, profile reuse,
  one-reload switching and external-server refusal.
- [x] Headless model → thinking → inference → context and same-workspace tab
  lifecycle tests.
- [x] Current-tree typecheck, full smoke suite, TUI smoke, build and pack dry run.
- [x] Real Gemma MTP x3 run plus controlled x3/x6/x8 depth observations.
- [x] Responsive TUI layout checks from 24 to 120 columns in dark/light themes.
- [x] Recommendation estimator coverage for 8 GB hybrid, 24 GB VRAM and
  64 GB RAM-only hardware classes.
- [x] Documentation, package contents and migration review.
- [x] Clean-install test from the final release tarball.
