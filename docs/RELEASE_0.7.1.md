# TinyCode 0.7.1 — Qwen MTP

## Added Qwen MTP support

- Embedded MTP heads are detected from GGUF `nextn_predict_layers` metadata.
  Qwen3.6 MTP-enabled GGUFs run without a separate draft model; ordinary GGUFs
  without the head are rejected for embedded MTP.
- Inference presets work with both embedded Qwen MTP and existing Gemma sidecars.
  Gemma settings are unchanged. Embedded MTP requires `parallel=1`, follows
  target placement and does not load a vision projector.
- `/models` distinguishes full MTP-enabled targets from sidecars, `/inference`
  no longer asks Qwen for a draft file, and `/info` shows the loaded mode/depth.
- Low-level draft depth is passed exactly; benchmark depths such as 4 or 5 are
  not rounded to interactive presets.
- Invalid metadata, mode or flags are checked before releasing a working
  TinyCode-owned runner. External servers are never reconfigured.

## Harness fixes

- Qwen XML function/parameter calls use tool schema types and the existing
  approval, read-before-edit and completion guards.
- Literal protocol tags in file content are preserved rather than normalized
  into tool actions. Incomplete XML calls are not executed.
- Actual-token preflight includes the same native tool definitions as generation.
- `node --experimental-strip-types --test` is recognized as verification,
  including commands prefixed with `cd … &&`; shell failure-masking operators
  remain rejected as verification evidence.

## Local Qwen benchmark results

Model: [Unsloth Qwen3.6-35B-A3B-MTP-GGUF, UD-IQ4_XS](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF).
RTX 3050 8 GB, llama.cpp b12110 CUDA, 32K context, Q8 KV, thinking on,
4096 output tokens, seed 42. Three offline tasks, strictly sequential.

| MTP depth | Hidden-check solved | Weighted decode | Acceptance | Total agent time |
| --- | ---: | ---: | ---: | ---: |
| 2 | 3/3 | 27.28 tok/s | 85.9% | 392.7 s |
| 3 | 3/3 | 27.23 tok/s | 79.1% | 352.6 s |

The deeper partial runs completed **Cache only**: depth 4 = 26.17 tok/s,
depth 6 = 23.37 tok/s, depth 16 = 14.51 tok/s. Remaining tasks are not counted
as failures or presented as completed suites.

Depth 3 finished these tasks about 10% sooner than depth 2, with effectively
equal decode throughput. The depth-2 Plugin task passed independent checks but
hit a false completion failure due to the verification recognition bug fixed
above. The original outcome and timing are preserved in the published data.

**These are single-seed observations on a frozen pre-release agent build, not
full-suite 0.7.1 results or a statistically stable model ranking.** A matched
no-draft control was not run, so no MTP-vs-standard speedup is claimed.

Methodology and per-case results: `docs/QWEN_MTP_BENCHMARK.md`.
Normalized exports: `data/qwen-mtp.json` and `data/model-efficiency.json`.
No weights, raw workspaces or prompts are included. TinyBench remains separate;
the website is unchanged.

## Release checks

Typecheck, full smoke suite, headless TUI, build, pack audit and clean tarball
installation. These checks use deterministic simulators, not new model runs.
