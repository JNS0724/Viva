# Third-Party Notices (`scripts/memory-eval/`)

Viva's own source code in this directory and repository remains licensed under the [MIT License](../../LICENSE).

The four English LLM-as-a-Judge system prompt templates in [`judge.ts`](./judge.ts) (`TEMPORAL_PROMPT`, `KNOWLEDGE_UPDATE_PROMPT`, `PREFERENCE_PROMPT`, `OTHER_PROMPT`) incorporate third-party prompt text from the following upstream projects. (`ABSTENTION_PROMPT` and `CHINESE_SEMANTIC_PROMPT` are authored specifically for Viva's evaluation harness.)

---

## 1. AgentScope ReMe (`agentscope-ai/ReMe`)

- **Component**: `plugins/lme-judge/src/judge_lme/llm_judge.yaml`
- **Pinned Revision**: Commit [`54fa338`](https://github.com/agentscope-ai/ReMe/blob/54fa338/plugins/lme-judge/src/judge_lme/llm_judge.yaml) (`v0.4.2.4`)
- **License**: Apache License, Version 2.0 (see [`../licenses/Apache-2.0.txt`](../licenses/Apache-2.0.txt) and upstream [`plugins/lme-judge/pyproject.toml`](https://github.com/agentscope-ai/ReMe/blob/54fa338/plugins/lme-judge/pyproject.toml))
- **Notice of Modifications**: Ported the four English judge prompt templates (`temporal-reasoning`, `knowledge-update`, `single-session-preference`, and `other`) from YAML format into TypeScript string constants in [`judge.ts`](./judge.ts) for execution inside Viva's Node/TypeScript evaluation harness, paired with Viva's own abstention (`ABSTENTION_PROMPT`) and Chinese semantic (`CHINESE_SEMANTIC_PROMPT`) rubrics.

---

## 2. LongMemEval (`xiaowu0162/LongMemEval`)

- **Component**: Evaluation judge prompt wording originally from [`src/evaluation/evaluate_qa.py`](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py)
- **License**: MIT License ([upstream `LICENSE`](https://github.com/xiaowu0162/LongMemEval/blob/main/LICENSE))

```text
MIT License

Copyright (c) 2024 Di Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
