import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sourceRoot = path.resolve(process.argv[2] ?? process.env.TINYBENCH_DATA_ROOT ?? "D:/TinyBench", "runs");
const outputFile = path.resolve(process.argv[3] ?? "data/model-efficiency.json");

const parse = async (file) => JSON.parse(await readFile(file, "utf8"));
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value, digits = 3) => value === null || value === undefined || !Number.isFinite(value)
  ? null : Number(value.toFixed(digits));

async function speculativeFor(runRoot, summary) {
  if (summary.speculative) return summary.speculative;
  const trial = `trial-${String(summary.repeat).padStart(2, "0")}`;
  const text = await readFile(path.join(runRoot, summary.case, summary.agent, trial, "llama-server.log"), "utf8").catch(() => "");
  let accepted = 0, drafted = 0, requests = 0;
  for (const match of text.matchAll(/\(\s*(\d+) accepted \/\s*(\d+) generated\)/g)) {
    accepted += Number(match[1]); drafted += Number(match[2]); requests++;
  }
  return requests ? { requests, accepted, drafted, acceptanceRate: drafted ? accepted / drafted : 0 } : null;
}

function profile(options) {
  if (options.speculativeType === "ngram-mod") return { id: "ngram", label: "N-gram" };
  if (options.speculativeType === "draft-mtp") {
    const depth = Number(options.draftMax ?? 0);
    return { id: `mtp-${depth}`, label: `MTP ${depth}x` };
  }
  return { id: "standard", label: "Standard" };
}

function suiteOf(summaries) {
  const cases = summaries.map((summary) => summary.case).sort();
  if (cases.length === 10) return "tinybench-core-10";
  if (cases.join(",") === ["py-cache-expiration", "ts-pagination-boundary", "ts-plugin-catalog-context"].sort().join(",")) return "mtp-depth-3";
  if (cases.length === 4) return "runtime-control-4";
  if (cases.length === 1) return `single:${cases[0]}`;
  return `custom-${cases.length}`;
}

async function aggregateRun(id) {
  const root = path.join(sourceRoot, id);
  const [run, summaries] = await Promise.all([parse(path.join(root, "run.json")), parse(path.join(root, "summaries.json"))]);
  const speculative = await Promise.all(summaries.map((summary) => speculativeFor(root, summary)));
  const outputTokens = summaries.reduce((sum, row) => sum + Number(row.tokens?.output ?? 0), 0);
  const inputTokens = summaries.reduce((sum, row) => sum + Number(row.tokens?.input ?? 0), 0);
  const generationSeconds = summaries.reduce((sum, row) => {
    const seconds = Number(row.tokens?.generationSeconds);
    const speed = Number(row.tokens?.tokensPerSecond);
    const output = Number(row.tokens?.output ?? 0);
    return sum + (Number.isFinite(seconds) && seconds > 0 ? seconds : Number.isFinite(speed) && speed > 0 ? output / speed : 0);
  }, 0);
  const drafted = speculative.reduce((sum, row) => sum + Number(row?.drafted ?? 0), 0);
  const accepted = speculative.reduce((sum, row) => sum + Number(row?.accepted ?? 0), 0);
  const solved = summaries.filter((row) => row.solved);
  const samples = summaries.reduce((sum, row) => sum + Number(row.resources?.sampleCount ?? 0), 0);
  const gpuWeighted = summaries.reduce((sum, row) => sum + Number(row.resources?.averageGpuUtilizationPercent ?? 0) * Number(row.resources?.sampleCount ?? 0), 0);
  const options = run.options ?? {};
  return {
    runId: id,
    suite: suiteOf(summaries),
    model: summaries[0]?.model ?? options.model ?? "unknown",
    agent: summaries[0]?.agent ?? "tinycode",
    runtime: options.runtime ?? "ollama",
    inference: profile(options),
    settings: {
      context: summaries[0]?.requestedContext ?? options.context ?? null,
      outputTokens: options.outputTokens ?? null,
      cacheMode: summaries[0]?.cacheMode ?? options.cacheMode ?? null,
      kvCacheType: options.kvCacheType ?? null,
      draftDevice: options.speculativeType === "draft-mtp" ? options.draftDevice ?? null : null,
      fitTargetMiB: options.fitTargetMiB ?? null,
      temperature: options.temperature ?? null,
      topP: options.topP ?? null,
      seeds: [...new Set(summaries.map((row) => row.seed))],
    },
    cases: summaries.map((row) => row.case),
    trials: summaries.length,
    solved: solved.length,
    solvedRate: round(solved.length / Math.max(1, summaries.length), 4),
    outcomes: Object.fromEntries([...new Set(summaries.map((row) => row.outcome))].sort().map((outcome) => [outcome, summaries.filter((row) => row.outcome === outcome).length])),
    medianSolvedSeconds: round(median(solved.map((row) => Number(row.timings?.agentDurationMs) / 1000))),
    medianAllSeconds: round(median(summaries.map((row) => Number(row.timings?.agentDurationMs) / 1000))),
    totalAgentSeconds: round(summaries.reduce((sum, row) => sum + Number(row.timings?.agentDurationMs ?? 0), 0) / 1000),
    weightedDecodeTokensPerSecond: round(generationSeconds > 0 ? outputTokens / generationSeconds : null),
    inputTokens,
    outputTokens,
    draftAcceptanceRate: drafted ? round(accepted / drafted, 4) : null,
    acceptedDraftTokens: drafted ? accepted : null,
    draftedTokens: drafted || null,
    tools: {
      total: summaries.reduce((sum, row) => sum + Number(row.tools?.total ?? 0), 0),
      successful: summaries.reduce((sum, row) => sum + Number(row.tools?.successful ?? 0), 0),
      failed: summaries.reduce((sum, row) => sum + Number(row.tools?.failed ?? 0), 0),
    },
    changedFiles: summaries.reduce((sum, row) => sum + Number(row.patch?.files?.length ?? 0), 0),
    falseSuccess: summaries.filter((row) => row.falseSuccess).length,
    falseFailure: summaries.filter((row) => row.falseFailure).length,
    resources: {
      peakSystemRamGiB: round(Math.max(...summaries.map((row) => Number(row.resources?.peakSystemRamUsedBytes ?? 0))) / 2 ** 30),
      peakGpuGiB: round(Math.max(...summaries.map((row) => Number(row.resources?.peakGpuUsedBytes ?? 0))) / 2 ** 30),
      averageGpuUtilizationPercent: samples ? round(gpuWeighted / samples, 2) : null,
    },
  };
}

const entries = [];
const excluded = [];
for (const id of (await readdir(sourceRoot)).sort()) {
  const root = path.join(sourceRoot, id);
  if (!(await stat(root)).isDirectory()) continue;
  try { entries.push(await aggregateRun(id)); }
  catch (error) { excluded.push({ runId: id, reason: error instanceof Error ? error.message.replaceAll(sourceRoot, "<runs>") : String(error) }); }
}

const core = entries.filter((entry) => entry.suite === "tinybench-core-10");
const data = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  title: "TinyCode local model efficiency observations",
  status: "research-single-seed",
  environment: {
    gpu: "NVIDIA RTX 3050 8 GB",
    context: 32768,
    execution: "sequential, cold cache, isolated offline workspaces",
  },
  caveats: [
    "Correctness ranks before speed; fast failed trials are not successful coding performance.",
    "Most observations use one seed and are not a statistically stable leaderboard.",
    "Runtime, quantization, cache type, draft depth and case set must match before comparing speeds.",
    "No model weights or absolute local file paths are included in this dataset.",
  ],
  coreModelComparison: core,
  inferenceExperiments: entries.filter((entry) => entry.suite !== "tinybench-core-10"),
  excludedRuns: excluded,
};

await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
process.stdout.write(`Collected ${entries.length} completed runs (${core.length} core model runs) -> ${outputFile}\n`);
