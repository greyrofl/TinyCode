# Model efficiency data

`model-efficiency.json` is a machine-readable research snapshot collected from
local TinyBench artifacts. It is prepared for a future website, but is not wired
into the site or presented as a public leaderboard yet.

The data keeps only normalized metrics and run IDs. It excludes model paths,
workspace paths, prompts and model weights. Most records are single-seed
observations, so correctness and speed are not statistically stable rankings.

Regenerate from a TinyBench data root:

```bash
node scripts/collect-model-efficiency.mjs D:/TinyBench data/model-efficiency.json
```
