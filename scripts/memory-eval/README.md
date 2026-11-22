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

# 3. Full-haystack LongMemEval run (no session cap)
DEEPSEEK_API_KEY=... npm run memory:eval -- --suite=lme \
  --lme-per-type=10 --lme-max-sessions=0 --concurrency=6 \
  --reme-python=/path/to/reme-venv/bin/python \
  --reme-repo=/path/to/ReMe
```
