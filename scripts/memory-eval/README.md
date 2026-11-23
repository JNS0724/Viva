# Memory System Evaluation vs. ReMe

Side-by-side evaluation harness comparing Viva's file memory system (`src/memory/`, `plugins/memory/`) against latest `agentscope-ai/ReMe` across four dimensions:

- **M4 (`offline`)**: Bilingual offline retrieval & `node_search` over frozen `evaluation` + `validation` sets (240 docs × 120 queries), comparing BM25-only and iso-embedding hybrid (`granite-embedding-97m-multilingual-r2-ONNX` q8 via localhost proxy).
- **M2 (`scale`)**: Index build, vector preparation, and p50/p95/p99 query latency + RSS across 100 / 1,000 / 3,000 documents.
- **M3 (`chinese`)**: Real-model comparison (`deepseek-flash`) on the 7 frozen Chinese semantic cases (`scripts/memory-semantic-cases.ts`), including cross-project / cross-scope isolation checks.
- **M1 (`lme`)**: Real-model stratified comparison (`deepseek-flash` + official `lme-judge` prompts) on LongMemEval `cleaned-s` across all 6 question categories (including abstention items).

## Usage

```bash
# 1. Offline retrieval + scale benchmark (zero LLM API cost)
npm run memory:eval -- --suite=offline,scale \
  --reme-python=/path/to/reme-venv/bin/python \
  --reme-repo=/path/to/ReMe

# 2. Real-model Chinese semantic + LongMemEval stratified scouting pass
DEEPSEEK_API_KEY=... npm run memory:eval -- --suite=chinese,lme \
  --lme-per-type=2 --lme-max-sessions=15 --concurrency=6 \
  --reme-python=/path/to/reme-venv/bin/python \
  --reme-repo=/path/to/ReMe

# 3. Strictly held-out LongMemEval blind test (excluding prior dev slice IDs, pure ReAct mode, exact HTTP token/cache metering)
DEEPSEEK_API_KEY=... npm run memory:eval -- --suite=lme \
  --lme-exclude-report=/path/to/prior-report.json \
  --lme-per-type=3 --lme-max-sessions=20 --viva-no-auto-context --concurrency=9 \
  --reme-python=/path/to/reme-venv/bin/python \
  --reme-repo=/path/to/ReMe

# Optional flags:
#   --viva-only                         Run only Viva (skip ReMe bridge and local embedding proxy)
#   --viva-no-auto-context              Disable automatic context pre-injection so both systems answer via ReAct tools only
#   --reme-enable-dream                 Enable auto_dream during ReMe LME runs (disabled by default to match ReMe's LME preset)
#   --lme-session-sampling=recent|answer-aware
#                                       How to truncate histories when --lme-max-sessions > 0 (default: label-free "recent";
#                                       "answer-aware" preserves answer_session_ids + evenly spaced distractors for controlled-length experiments)
```

## External Datasets & Licensing

This repository does **not** redistribute LongMemEval datasets, per-item ground-truth answers, or raw benchmark dialogues; the evaluation runner loads benchmark files from an external path (`--lme-dataset` or a locally checked-out ReMe clone).

- **Original LongMemEval cleaned dataset**: [`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) (dataset card lists **MIT License**).
- **ReMe revised LongMemEval-S dataset**: [`agentscope-ai/ReMe_longmemeval_clean_s_v2`](https://huggingface.co/datasets/agentscope-ai/ReMe_longmemeval_clean_s_v2) (documents data corrections and requests citing the original LongMemEval paper; check upstream dataset terms before redistributing cleaned JSON, ground-truth answers, or raw dialogues).
- **Third-party judge prompt notices**: The four English LongMemEval judge prompts in [`judge.ts`](./judge.ts) are ported from `agentscope-ai/ReMe` (`54fa338`, Apache-2.0) and upstream `xiaowu0162/LongMemEval` (MIT, Copyright (c) 2024 Di Wu). See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and [`../licenses/Apache-2.0.txt`](../licenses/Apache-2.0.txt). Viva's own code remains licensed under the [MIT License](../../LICENSE).

## Benchmark Scope Note

Published LongMemEval numbers from this harness represent **controlled side-by-side experiments run by the Viva team under the recorded configuration** (specific stratified slice ID, `--lme-max-sessions` cap, model, embedding backend, and Viva's own abstention prompt in [`judge.ts`](./judge.ts) for `_abs` questions) — they are **not** official full 500-item LongMemEval leaderboard scores. Always report the exact slice fingerprint, session cap, and harness flags alongside aggregate metrics.

