<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/greyrofl/TinyCode/main/docs/assets/tinycode-logo-dark.svg">
  <img src="https://raw.githubusercontent.com/greyrofl/TinyCode/main/docs/assets/tinycode-logo-light.svg" alt="TinyCode" width="470">
</picture>

### Lightweight local-first coding agent for capable GGUF models

`llama.cpp` · `Ollama` · `OpenAI-compatible` · `GGUF` · `TUI`

[![npm](https://img.shields.io/npm/v/tinycode-cli?style=flat-square&logo=npm)](https://www.npmjs.com/package/tinycode-cli)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020.11-339933?style=flat-square&logo=node.js&logoColor=white)](#requirements)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4b5563?style=flat-square)](#requirements)
[![license](https://img.shields.io/badge/license-MIT-86efac?style=flat-square)](LICENSE)

[Русская версия](README_RU.md) · [Releases](https://github.com/greyrofl/TinyCode/releases) · [Documentation](#documentation)

</div>

TinyCode is an experimental terminal coding agent for local models. It owns the
model lifecycle, keeps durable sessions, runs a guarded tool loop, and presents
everything through a dependency-light terminal UI.

It can launch local GGUF files directly through managed
[llama.cpp](https://github.com/ggml-org/llama.cpp), use an existing
[Ollama](https://ollama.com) installation, or connect to explicitly configured
OpenAI-compatible endpoints.

> **Local-first, not “always offline.”** Local inference is the default path,
> but web tools and remote providers are available when you enable or use them.
> Model weights are never downloaded automatically.

## Why TinyCode

TinyCode is not just a chat wrapper around a model server. It focuses on the
parts that make local coding agents predictable:

- one ordered model/tool stream — no hidden parallel branches;
- read-before-edit, duplicate-call and no-progress guards;
- approval-gated commands, verification and restricted MCP tools;
- durable sessions, queued steering, retry, export and context compaction;
- exact context selection with no silent history truncation;
- managed llama.cpp ownership, RAM/VRAM telemetry and controlled reloads;
- per-model thinking, sampling and speculative inference profiles;
- embedded Qwen MTP and Gemma sidecar MTP support;
- 29 built-in tools plus configured MCP tools.

“Tiny” describes the lightweight agent and UI. It is not a promise that every
sub-8B model can reliably solve repository-level tasks. The primary target is a
capable local instruct/coding model, typically around 8B or larger.

## Requirements

- Node.js **20.11+**;
- Windows, macOS or Linux;
- an already downloaded local model, or an explicitly configured API endpoint.

TinyCode never downloads model weights. For direct GGUF inference it can install
an official llama.cpp binary on first model load, with size and SHA-256
verification. You can disable this with `llama.autoInstall: false`.

## Installation

```bash
npm install --global tinycode-cli
tinycode --version
```

Install from source:

```bash
git clone https://github.com/greyrofl/TinyCode.git
cd TinyCode
npm ci
npm run build
npm link
```

## Quick start

### Interactive model selection

```bash
cd /path/to/your/project
tinycode
```

The welcome screen does not load model weights. Open `/models`, select a provider
and model, then choose thinking, inference profile and context. The model is
loaded only when you send the first prompt.

### Direct GGUF through llama.cpp

```bash
cd /path/to/your/project
tinycode --provider llama.cpp --model /path/to/model.gguf
```

TinyCode also discovers GGUFs in:

- `~/.tinytcode/models`;
- `./models` in the current project;
- `LLAMA_CACHE` or `~/.cache/llama.cpp`;
- configured `llama.modelDirs`;
- the local Ollama model store, without copying blobs.

### Ollama

```bash
ollama pull qwen3:8b
cd /path/to/your/project
tinycode --provider ollama --model qwen3:8b
```

### One-shot mode

```bash
tinycode run --provider ollama --model qwen3:8b "Inspect the project and explain its architecture"
```

Normal answer text goes to stdout. Status, reasoning, tools and approvals go to
stderr, so one-shot mode can be composed with shell scripts.

## Inference profiles

For TinyCode-owned llama.cpp processes, `/inference` stores a profile per model:

| Profile | Behavior |
| --- | --- |
| **Standard** | Target model only; maximum compatibility |
| **N-gram** | Prompt lookup speculation without extra weights |
| **MTP 2x/3x/6x/8x** | Model-specific multi-token prediction depth |

Supported MTP layouts:

- **Qwen embedded MTP** — detected from GGUF `nextn_predict_layers`; no sidecar;
- **Gemma sidecar MTP** — an explicit compatible local draft GGUF.

Example with an already downloaded Qwen MTP model:

```bash
ollama pull "hf.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-IQ4_XS"
tinycode
```

Select the `ollama-cache/...Qwen3.6...MTP...` entry under llama.cpp and choose
MTP 2x or 3x. Embedded MTP requires `parallel=1`, follows the target placement,
and does not load a vision projector.

MTP depth is not a guaranteed speed multiplier. Compare it against Standard on
your own model, quantization, context and hardware.

## Agent loop and tools

```text
user → model → tool call → guard/approval → local execution → observation → model
```

| Group | Built-in tools |
| --- | --- |
| Read/search | `read_file`, `read_files`, `list_dir`, `find_files`, `search_text`, `file_info` |
| Edit | `create_file`, `replace_file`, `edit_file`, `apply_patch` |
| Paths | `make_directory`, `move_path`, `copy_path`, `delete_file`, `delete_directory` |
| Git | `git_status`, `git_diff`, `git_log`, `git_show` |
| Checks | `diagnostics`, `verify` |
| Commands/processes | `execute_command`, `start_process`, `process_status`, `list_processes`, `stop_process` |
| Network | `web_search`, `fetch_url` |
| Response | `say` |

File tools are confined to the working directory and reject `..` and symlink
escapes. `execute_command`, `start_process`, `verify`, and MCP tools declared
with `safe: false` require approval unless `--yes` is used.

Tool profiles:

| Profile | Scope |
| --- | --- |
| `auto` | staged plan → edit → verify exposure |
| `plan` | reading, search, Git and diagnostics |
| `edit` | reading, edits and checks |
| `full` | all tools, including shell, processes, network and MCP |

Commands and MCP servers are **not a sandbox**. They run with the current user's
operating-system permissions.

## Sessions and context

TinyCode stores state under `~/.tinytcode`:

```text
config.json
history.json
engines/
models/
sessions/<session-id>/
  meta.json
  messages.jsonl
```

- workspace sessions appear as persistent tabs;
- closing a tab hides it without deleting its history;
- input sent during generation is queued and applied at an ordered boundary;
- `/retry` regenerates the latest request;
- `/compact` creates durable session memory;
- `/export` writes the session as Markdown.

TinyCode keeps full active history until compaction. It does not select a hidden
head/tail subset. Direct llama.cpp requests are checked with the model's own chat
template and tokenizer before generation; overflow is rejected rather than
silently truncated.

## Providers

| Capability | llama.cpp | Ollama | OpenAI-compatible |
| --- | --- | --- | --- |
| Model source | local GGUF | local Ollama library | user-configured endpoint |
| Process ownership | TinyCode-owned child or external server | local Ollama daemon | external owner |
| RAM/VRAM telemetry | local managed runtime | `/api/ps` | unavailable |
| Physical context reload | controlled child restart | runner unload/reload | not managed |
| Thinking controls | GGUF template and `/props` | `/api/show` | manually configured |

Remote providers are opt-in. Prompts, history and tool results leave your machine
when you select a remote endpoint.

## Configuration

Configuration file:

```text
~/.tinytcode/config.json
```

Minimal direct-GGUF example:

```json
{
  "provider": "llama.cpp",
  "model": "coder",
  "llama": {
    "models": {
      "coder": "D:/models/coder-Q4_K_M.gguf"
    },
    "backend": "auto",
    "gpuLayers": "auto",
    "parallel": 1
  }
}
```

Minimal OpenAI-compatible provider:

```json
{
  "provider": "local-api",
  "providers": {
    "local-api": {
      "type": "openai-compatible",
      "name": "My endpoint",
      "baseUrl": "http://127.0.0.1:9000/v1",
      "apiKeyEnv": "LOCAL_AI_KEY",
      "models": {
        "coder": {
          "name": "Coder",
          "contextLength": 32768,
          "parameterSize": "14B",
          "thinking": false
        }
      }
    }
  }
}
```

Keep credentials in environment variables referenced by `apiKeyEnv`; do not put
secrets directly in the config file.

## CLI reference

```text
tinycode [options]                 interactive TUI
tinycode run [options] [prompt]    one-shot mode; reads piped stdin
tinycode resume [session]          resume a saved session
tinycode compact [session]         compact older turns into durable memory
tinycode models [--json]           list models for the selected provider
tinycode tools [--json]            list tools and approval levels
tinycode sessions [--json]         list saved sessions
tinycode config [--path|--json]    show effective configuration
tinycode doctor                    inspect provider and local state
```

Common flags:

```text
--provider <id>                    llama.cpp, ollama, or configured provider
-m, --model <id>                   model id, alias, or GGUF path
--context <tokens>                 physical context for this session
--think <mode>                     model thinking mode
--inference <profile>              standard, ngram, mtp-2/3/6/8
--draft-model <path.gguf>          explicit sidecar for compatible MTP targets
--profile <name>                   model, auto, plan, edit, full
-y, --yes                          auto-approve restricted tools
```

Use `/help` in the TUI for the complete slash-command list.

## Model recommendations

`/recommend` estimates whether curated 8B–32B coding models fit VRAM, hybrid
VRAM/RAM, or RAM-only placement with at least a 32K context. The estimate
includes model weights, F16 KV, compute reserve and OS memory. Selecting a model
still requires approval before its install command runs.

Recommendations are hardware estimates, not quality guarantees. Model/tool
template compatibility must be tested on real tasks.

## Benchmark evidence

The repository contains normalized research data, not a universal leaderboard.
For example, a local Qwen3.6-35B-A3B-MTP UD-IQ4_XS depth check on an RTX 3050
8 GB (32K context, one seed, three offline tasks) produced:

| MTP depth | Hidden-check solved | Weighted decode | Acceptance |
| --- | ---: | ---: | ---: |
| 2 | 3/3 | 27.28 tok/s | 85.9% |
| 3 | 3/3 | 27.23 tok/s | 79.1% |

This is not a full-suite result, and no matched no-draft control was run. See
[methodology and caveats](docs/QWEN_MTP_BENCHMARK.md),
[`data/qwen-mtp.json`](data/qwen-mtp.json), and
[`data/model-efficiency.json`](data/model-efficiency.json).

## Privacy and safety

- model weights are never downloaded automatically;
- local file tools stay inside the selected workspace;
- incomplete tool calls are not executed;
- external providers receive conversation data only when selected;
- `web_search` and `fetch_url` access the network when invoked;
- commands and MCP tools are not sandboxed;
- goal evaluation improves completion discipline but is not formal proof of
  correctness.

Review commands before approval and connect only trusted MCP servers.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm run smoke
npm run smoke:tui
npm pack --dry-run
```

The smoke suite uses deterministic simulators. It does not download engines or
model weights and does not require a GPU.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Engine lifecycle and inference](docs/ENGINES.md)
- [Qwen MTP benchmark methodology](docs/QWEN_MTP_BENCHMARK.md)
- [Local model evaluation notes](docs/LOCAL_MODEL_EVALUATION.md)
- [Benchmark specification](docs/BENCHMARK_0.6.md)
- [Release notes](https://github.com/greyrofl/TinyCode/releases)

Issues and compatibility reports are welcome. Include the OS, hardware, model
and quant, provider/runtime, context size, and relevant logs without secrets.

## License

[MIT](LICENSE)
