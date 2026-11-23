#!/usr/bin/env python3
"""Bridge script invoking the real latest agentscope-ai/ReMe (in-process Application)
for apples-to-apples comparison against Viva's file memory system.

Subcommands (JSON via --input / --output files):
  - offline-eval: index exact Markdown docs + run SearchStep & NodeSearchStep
  - scale-bench:  index N synthetic Markdown docs + measure p50/p95/p99 latency & RSS
  - chinese-eval: run auto_memory + auto_dream + agentic_answer on frozen Chinese semantic cases
  - lme-eval:     run ReMe lme pipeline (auto_memory + optional auto_dream + agentic_answer) on LME slice
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


def _safe_work_subdir(work_dir: str, item_id: str) -> Path:
    base = Path(work_dir).resolve()
    prefix = re.sub(r"[^A-Za-z0-9_-]+", "_", str(item_id)).strip("_")[:40] or "item"
    digest = hashlib.sha256(str(item_id).encode("utf-8")).hexdigest()[:12]
    target = (base / f"{prefix}-{digest}").resolve()
    if not target.is_relative_to(base) or target == base:
        raise ValueError(f"Refusing unsafe work directory outside root: {item_id}")
    return target


def _require_job_success(resp: Any, stage: str) -> Any:
    """Fail explicitly when a ReMe run_job() returns success=False instead of raising."""
    if resp is None:
        raise RuntimeError(f"ReMe job '{stage}' returned None")
    success = resp.get("success", True) if isinstance(resp, dict) else getattr(resp, "success", True)
    if success is False:
        detail = (
            (resp.get("error") or resp.get("message") or resp.get("answer"))
            if isinstance(resp, dict)
            else (getattr(resp, "error", None) or getattr(resp, "message", None) or getattr(resp, "answer", None))
        )
        msg = str(detail or "unknown failure").strip()[:240]
        raise RuntimeError(f"ReMe job '{stage}' returned success=False: {msg}")
    return resp

try:
    import resource
except ImportError:  # Windows does not provide POSIX resource module
    resource = None  # type: ignore[assignment]


def _peak_rss_mb() -> float:
    if resource is not None:
        rss_bytes = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # macOS ru_maxrss is in bytes; Linux is KiB
        return rss_bytes / (1024 * 1024) if sys.platform == "darwin" else rss_bytes / 1024.0
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class _ProcessMemoryCounters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = _ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                return counters.PeakWorkingSetSize / (1024 * 1024)
        except Exception:
            return 0.0
    return 0.0


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int((len(ordered) * fraction + 0.999999) - 1)))
    return ordered[idx]


def _workspace_stats(workspace_dir: Path) -> dict[str, Any]:
    daily_files = 0
    digest_files = 0
    session_files = 0
    total_bytes = 0
    file_paths: list[str] = []
    for sub, kind in (("daily", "daily"), ("digest", "digest"), ("session", "session")):
        root = workspace_dir / sub
        if not root.exists():
            continue
        for p in sorted(root.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(workspace_dir).as_posix()
            total_bytes += p.stat().st_size
            file_paths.append(rel)
            if kind == "daily" and p.suffix == ".md":
                daily_files += 1
            elif kind == "digest" and p.suffix == ".md":
                digest_files += 1
            elif kind == "session":
                session_files += 1
    return {
        "dailyFiles": daily_files,
        "digestFiles": digest_files,
        "sessionFiles": session_files,
        "totalBytes": total_bytes,
        "filePaths": file_paths,
    }


def _configure_app_dict(
    workspace_dir: str,
    *,
    plugins: list[str],
    embedding_url: str | None,
    embedding_dims: int,
    llm_model: str,
    llm_base_url: str,
    llm_api_key: str,
    enable_dream: bool,
    index_sessions: bool,
) -> dict[str, Any]:
    from reme.config import resolve_app_config

    cfg = resolve_app_config(
        config="benchmark",
        plugins=plugins,
        workspace_dir=workspace_dir,
        log_to_console=False,
        log_to_file=False,
        enable_logo=False,
    )

    # Configure LLM (identical DeepSeek endpoint & model as Viva)
    for llm_name in ("default", "bench", "compressor"):
        if llm_name in cfg["components"]["as_llm"]:
            entry = cfg["components"]["as_llm"][llm_name]
            entry["backend"] = "openai"
            entry["model"] = llm_model
            entry["credential"] = {"api_key": llm_api_key, "base_url": llm_base_url}
            entry.setdefault("parameters", {})
            entry["parameters"]["thinking_enable"] = False
            entry["parameters"]["max_tokens"] = 4096
            entry["max_retries"] = 3
            entry["retry_delay"] = 2.0

    # Configure Embedding: either BM25-only (ReMe default) or local Granite-97M proxy (iso-embedding)
    if embedding_url:
        cfg["components"]["as_embedding"]["default"] = {
            "backend": "openai",
            "model": "granite-embedding-97m-multilingual-r2",
            "credential": {"api_key": "local-granite", "base_url": embedding_url},
            "dimensions": embedding_dims,
        }
        cfg["components"]["file_store"]["default"]["embedding_store"] = "default"
    else:
        cfg["components"]["file_store"]["default"]["embedding_store"] = ""

    # Index watch dirs: optionally include session/dialog (ReMe LME default) or daily+digest only
    if index_sessions:
        cfg["jobs"]["index_update"]["watch_dirs"] = ["daily_dir", "digest_dir", "session_dir/dialog"]
        cfg["jobs"]["index_update"]["watch_suffixes"] = ["md", "jsonl"]
    else:
        cfg["jobs"]["index_update"]["watch_dirs"] = ["daily_dir", "digest_dir"]
        cfg["jobs"]["index_update"]["watch_suffixes"] = ["md"]

    # Enable auto_dream job from default.yaml when requested
    if enable_dream and "auto_dream" not in cfg["jobs"]:
        cfg["jobs"]["auto_dream"] = {
            "backend": "base",
            "description": "Auto-dream consolidation",
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {"type": "string", "default": ""},
                    "hint": {"type": "string", "default": ""},
                    "scan_days": {"type": "integer", "default": 2},
                    "max_units": {"type": "integer", "default": 5},
                    "max_chars_per_batch": {"type": "integer", "default": 40000},
                },
            },
            "steps": [
                {"backend": "dream_extract_step", "file_catalog": "dream", "scan_days": 2, "max_units": 5, "max_chars_per_batch": 40000},
                {"backend": "dream_integrate_step"},
                {"backend": "dream_finish_step", "file_catalog": "dream"},
                {"backend": "auto_tag_step"},
            ],
        }

    # Ensure search job exists even when lme plugin is not loaded
    if "search" not in cfg["jobs"]:
        cfg["jobs"]["search"] = {
            "backend": "base",
            "description": "Hybrid workspace search",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "default": 5},
                    "min_score": {"type": "number", "default": 0.0},
                    "start_date": {"type": "string", "default": ""},
                    "end_date": {"type": "string", "default": ""},
                },
                "required": ["query"],
            },
            "steps": [
                {
                    "backend": "search_step",
                    "vector_weight": 0.7,
                    "candidate_multiplier": 5.0,
                    "expand_links": True,
                    "max_links_per_direction": 10,
                }
            ],
        }

    return cfg


def _extract_hits_from_search_response(resp: Any, path_to_id: dict[str, str]) -> list[dict[str, Any]]:
    meta = getattr(resp, "metadata", None) or {}
    # SearchStep / SearchV2Step stores structured results in metadata['chunks'] or ['results'] or ['hits']
    raw_items = meta.get("chunks") or meta.get("results") or meta.get("hits") or []
    hits: list[dict[str, Any]] = []
    for item in raw_items:
        if isinstance(item, dict):
            path = str(item.get("path", ""))
            text = str(item.get("content") or item.get("text") or "")
            score = float(item.get("score", 0.0))
        else:
            path = str(getattr(item, "path", ""))
            text = str(getattr(item, "content", "") or getattr(item, "text", ""))
            score = float(getattr(item, "score", 0.0))
        norm = path.lstrip("/")
        hits.append({"id": path_to_id.get(norm, norm), "path": norm, "text": text, "score": score})

    if hits:
        return hits

    # Fallback: parse SearchStep formatted answer lines (`[1] path:lines (score=...)`)
    answer = str(getattr(resp, "answer", "") or "")
    import re

    blocks = re.split(r"(?m)^(?=\[\d+\]\s+)", answer)
    for block in blocks:
        m = re.match(r"^\[(\d+)\]\s+([^\s:]+)(?::\d+-\d+)?(?:\s*\(([^)]*)\))?", block.strip())
        if not m:
            continue
        norm = m.group(2).lstrip("/")
        score_str = m.group(3) or ""
        sm = re.search(r"score=([0-9.eE+-]+)", score_str)
        score = float(sm.group(1)) if sm else 0.0
        hits.append({"id": path_to_id.get(norm, norm), "path": norm, "text": block, "score": score})
    return hits


def _extract_nodes_from_node_search_response(resp: Any, path_to_id: dict[str, str]) -> list[dict[str, Any]]:
    meta = getattr(resp, "metadata", None) or {}
    raw_hits = meta.get("hits") or meta.get("nodes") or []
    out: list[dict[str, Any]] = []
    for item in raw_hits:
        if isinstance(item, dict):
            norm = str(item.get("path", "")).lstrip("/")
            out.append({"id": path_to_id.get(norm, norm), "path": norm, "score": float(item.get("score", 0.0))})
    if out:
        return out
    import re
    answer = str(getattr(resp, "answer", "") or "")
    for line in answer.splitlines():
        m = re.search(r"(digest/[^\s|)]+\.md)", line)
        if m:
            norm = m.group(1).lstrip("/")
            out.append({"id": path_to_id.get(norm, norm), "path": norm, "score": 0.0})
    return out


async def cmd_offline_eval(payload: dict[str, Any]) -> dict[str, Any]:
    from reme import Application

    work_dir = Path(payload["workDir"])
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    path_to_id: dict[str, str] = {}
    for doc in payload["documents"]:
        rel = doc["path"]
        path_to_id[rel] = doc["id"]
        full = work_dir / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(doc["markdown"], encoding="utf-8")

    cfg = _configure_app_dict(
        str(work_dir),
        plugins=[],
        embedding_url=payload.get("embeddingUrl"),
        embedding_dims=int(payload.get("embeddingDims", 384)),
        llm_model="deepseek-flash",
        llm_base_url="https://api.deepseek.com/v1",
        llm_api_key="unused-offline",
        enable_dream=False,
        index_sessions=False,
    )
    app = Application(**cfg)
    await app.start()
    try:
        t0 = time.perf_counter()
        _require_job_success(await app.run_job("index_update"), "offline/index_update")
        index_ms = (time.perf_counter() - t0) * 1000.0

        query_results = []
        for q in payload["queries"]:
            qs = time.perf_counter()
            kwargs: dict[str, Any] = {"query": q["text"], "limit": int(payload.get("limit", 5))}
            if q.get("from"):
                kwargs["start_date"] = q["from"]
            if q.get("through"):
                kwargs["end_date"] = q["through"]
            resp = _require_job_success(await app.run_job("search", **kwargs), f"offline/search({q['id']})")
            elapsed_ms = (time.perf_counter() - qs) * 1000.0
            hits = _extract_hits_from_search_response(resp, path_to_id)
            query_results.append({
                "id": q["id"],
                "elapsedMs": elapsed_ms,
                "hits": hits,
            })

        node_results = []
        for q in payload.get("nodeQueries", []):
            qs = time.perf_counter()
            resp = _require_job_success(await app.run_job("node_search", query=q["text"], limit=5), f"offline/node_search({q['id']})")
            elapsed_ms = (time.perf_counter() - qs) * 1000.0
            nodes = _extract_nodes_from_node_search_response(resp, path_to_id)
            node_results.append({
                "id": q["id"],
                "elapsedMs": elapsed_ms,
                "nodes": nodes,
            })

        return {
            "indexMs": index_ms,
            "queries": query_results,
            "nodeQueries": node_results,
        }
    finally:
        await app.close()


async def cmd_scale_bench_point(payload: dict[str, Any]) -> dict[str, Any]:
    from reme import Application

    doc_count = int(payload["docCount"])
    work_dir = Path(payload["workDir"]) / f"scale_{doc_count}"
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    for i in range(doc_count):
        day = f"2026-{(i % 10) + 1:02d}-{(i % 27) + 1:02d}"
        if i % 3 == 0:
            rel = f"daily/{day}/note-{i:05d}.md"
        else:
            rel = f"digest/wiki/doc-{i:05d}.md"
        body = (
            f"---\nname: Topic {i}\ndescription: Benchmark synthetic memory entry {i} for scale testing\n---\n\n"
            f"# Entry {i}\n\n"
            f"Project code SIGMA-{1000 + i} handles service routing on port {8000 + (i % 500)}.\n"
            f"中文测试条目 {i}：关于季度预算复核、接口限流策略与每周例会安排的备忘记录。\n"
            f"Owner is engineer_{i % 40} in team_{i % 12}. Approval requires checklist-{i % 25}.\n"
        )
        full = work_dir / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(body, encoding="utf-8")

    cfg = _configure_app_dict(
        str(work_dir),
        plugins=[],
        embedding_url=payload.get("embeddingUrl"),
        embedding_dims=int(payload.get("embeddingDims", 384)),
        llm_model="deepseek-flash",
        llm_base_url="https://api.deepseek.com/v1",
        llm_api_key="unused-offline",
        enable_dream=False,
        index_sessions=False,
    )
    app = Application(**cfg)
    await app.start()
    try:
        t0 = time.perf_counter()
        await app.run_job("index_update")
        index_ms = (time.perf_counter() - t0) * 1000.0

        queries = [
            f"SIGMA-{1000 + (k * max(1, doc_count // 30)) % doc_count} routing port"
            if k % 2 == 0
            else f"中文测试条目 {(k * max(1, doc_count // 30)) % doc_count} 季度预算 接口限流"
            for k in range(30)
        ]
        latencies = []
        for q in queries:
            qs = time.perf_counter()
            await app.run_job("search", query=q, limit=5)
            latencies.append((time.perf_counter() - qs) * 1000.0)

        rss_mb = _peak_rss_mb()
        is_hybrid = bool(payload.get("embeddingUrl"))
        return {
            "docCount": doc_count,
            "chunkCount": doc_count,
            "indexMs": index_ms,
            "vectorPrepMs": 0.0,
            "lexicalP50Ms": 0.0 if is_hybrid else _percentile(latencies, 0.5),
            "lexicalP95Ms": 0.0 if is_hybrid else _percentile(latencies, 0.95),
            "lexicalP99Ms": 0.0 if is_hybrid else _percentile(latencies, 0.99),
            "hybridP50Ms": _percentile(latencies, 0.5) if is_hybrid else None,
            "hybridP95Ms": _percentile(latencies, 0.95) if is_hybrid else None,
            "hybridP99Ms": _percentile(latencies, 0.99) if is_hybrid else None,
            "rssMb": round(rss_mb, 1),
        }
    finally:
        await app.close()


async def cmd_scale_bench(payload: dict[str, Any]) -> dict[str, Any]:
    """Run each docCount in a fresh Python child process so peak RSS never inherits earlier scale points."""
    points = []
    work_root = Path(payload["workDir"])
    work_root.mkdir(parents=True, exist_ok=True)
    script_path = Path(__file__).resolve()
    for doc_count in payload["docCounts"]:
        point_in = work_root / f"point_{doc_count}_in.json"
        point_out = work_root / f"point_{doc_count}_out.json"
        point_payload = {
            "workDir": str(work_root),
            "docCount": int(doc_count),
            "embeddingUrl": payload.get("embeddingUrl"),
            "embeddingDims": int(payload.get("embeddingDims", 384)),
        }
        point_in.write_text(json.dumps(point_payload, ensure_ascii=False), encoding="utf-8")
        proc = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, str(script_path), "scale-bench-point", "--input", str(point_in), "--output", str(point_out)],
            check=True,
            capture_output=True,
            text=True,
        )
        if proc.stderr.strip():
            print(proc.stderr.strip(), file=sys.stderr, flush=True)
        points.append(json.loads(point_out.read_text(encoding="utf-8")))
    return {"points": points}


def _empty_telemetry() -> dict[str, Any]:
    return {
        "llmCalls": 0,
        "inputTokens": 0,
        "cacheReadTokens": 0,
        "outputTokens": 0,
        "ingestMs": 0.0,
        "dreamMs": 0.0,
        "answerMs": 0.0,
        "toolCalls": 0,
        "toolNames": {},
        "phaseTokens": {
            "ingest": {"calls": 0, "inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0},
            "dream": {"calls": 0, "inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0},
            "answer": {"calls": 0, "inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0},
        },
    }


def _extract_openai_usage(usage: Any) -> tuple[int, int, int]:
    if usage is None:
        return 0, 0, 0
    prompt = int(getattr(usage, "prompt_tokens", None) or (usage.get("prompt_tokens") if isinstance(usage, dict) else 0) or 0)
    completion = int(getattr(usage, "completion_tokens", None) or (usage.get("completion_tokens") if isinstance(usage, dict) else 0) or 0)
    cached = int(getattr(usage, "prompt_cache_hit_tokens", None) or (usage.get("prompt_cache_hit_tokens") if isinstance(usage, dict) else 0) or 0)
    if not cached:
        details = getattr(usage, "prompt_tokens_details", None) or (usage.get("prompt_tokens_details") if isinstance(usage, dict) else None)
        if details is not None:
            cached = int(getattr(details, "cached_tokens", None) or (details.get("cached_tokens") if isinstance(details, dict) else 0) or 0)
    return prompt, cached, completion


def _record_usage(telemetry: dict[str, Any], phase: str, prompt: int, cached: int, completion: int) -> None:
    if prompt <= 0 and completion <= 0:
        return
    telemetry["inputTokens"] += prompt
    telemetry["cacheReadTokens"] += cached
    telemetry["outputTokens"] += completion
    bucket = telemetry["phaseTokens"].get(phase)
    if bucket is not None:
        bucket["inputTokens"] += prompt
        bucket["cacheReadTokens"] += cached
        bucket["outputTokens"] += completion


class _MeteredAsyncStream:
    """Proxy for openai.AsyncStream preserving both async iteration and async context manager protocol."""

    def __init__(self, inner: Any, telemetry: dict[str, Any], phase: str) -> None:
        self._inner = inner
        self._telemetry = telemetry
        self._phase = phase
        self._seen_tools: dict[int, str] = {}
        self._final_usage: Any = None
        self._recorded = False

    def _flush(self) -> None:
        if self._recorded:
            return
        self._recorded = True
        p, c, o = _extract_openai_usage(self._final_usage)
        _record_usage(self._telemetry, self._phase, p, c, o)
        if self._phase == "answer":
            for name in self._seen_tools.values():
                self._telemetry["toolCalls"] += 1
                self._telemetry["toolNames"][name] = self._telemetry["toolNames"].get(name, 0) + 1

    async def __aenter__(self) -> "_MeteredAsyncStream":
        if hasattr(self._inner, "__aenter__"):
            await self._inner.__aenter__()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> Any:
        self._flush()
        if hasattr(self._inner, "__aexit__"):
            return await self._inner.__aexit__(exc_type, exc, tb)
        return False

    def __aiter__(self) -> "_MeteredAsyncStream":
        self._aiter = self._inner.__aiter__()
        return self

    async def __anext__(self) -> Any:
        try:
            chunk = await self._aiter.__anext__()
        except StopAsyncIteration:
            self._flush()
            raise
        if getattr(chunk, "usage", None) is not None:
            self._final_usage = chunk.usage
        for choice in getattr(chunk, "choices", None) or ():
            delta = getattr(choice, "delta", None)
            for tc in getattr(delta, "tool_calls", None) or ():
                idx = int(getattr(tc, "index", 0) or 0)
                fn = getattr(tc, "function", None)
                name = getattr(fn, "name", None) if fn is not None else None
                if idx not in self._seen_tools:
                    self._seen_tools[idx] = name or "unknown"
                elif name and self._seen_tools[idx] == "unknown":
                    self._seen_tools[idx] = name
        return chunk

    async def close(self) -> None:
        self._flush()
        if hasattr(self._inner, "close"):
            await self._inner.close()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _install_llm_meter(app: Any, telemetry: dict[str, Any], phase_ref: list[str]) -> None:
    """Wrap AsyncOpenAI chat.completions.create on every ReMe as_llm component for exact HTTP call, tool, and token accounting."""
    as_llms = getattr(getattr(app, "context", None), "components", {}).get("as_llm", {})
    for comp in as_llms.values():
        model = getattr(comp, "model", None)
        client = getattr(model, "client", None)
        completions = getattr(getattr(client, "chat", None), "completions", None)
        orig_create = getattr(completions, "create", None)
        if orig_create is None or getattr(orig_create, "_viva_metered", False):
            continue

        async def _wrapped_create(*args: Any, _orig: Any = orig_create, **kwargs: Any) -> Any:
            phase = phase_ref[0]
            telemetry["llmCalls"] += 1
            bucket = telemetry["phaseTokens"].get(phase)
            if bucket is not None:
                bucket["calls"] += 1
            if kwargs.get("stream"):
                stream_opts = dict(kwargs.get("stream_options") or {})
                stream_opts.setdefault("include_usage", True)
                kwargs["stream_options"] = stream_opts
            resp = await _orig(*args, **kwargs)
            if kwargs.get("stream") and hasattr(resp, "__aiter__"):
                return _MeteredAsyncStream(resp, telemetry, phase)
            p, c, o = _extract_openai_usage(getattr(resp, "usage", None))
            _record_usage(telemetry, phase, p, c, o)
            if phase == "answer":
                for choice in getattr(resp, "choices", None) or ():
                    msg = getattr(choice, "message", None)
                    for tc in getattr(msg, "tool_calls", None) or ():
                        fn = getattr(tc, "function", None)
                        name = getattr(fn, "name", None) or "unknown"
                        telemetry["toolCalls"] += 1
                        telemetry["toolNames"][name] = telemetry["toolNames"].get(name, 0) + 1
            return resp

        setattr(_wrapped_create, "_viva_metered", True)
        completions.create = _wrapped_create


async def cmd_chinese_eval(payload: dict[str, Any]) -> dict[str, Any]:
    from reme import Application

    api_key = os.environ["DEEPSEEK_API_KEY"].strip()
    llm_model = payload.get("llmModel", "deepseek-flash")
    llm_base_url = payload.get("llmBaseUrl", "https://api.deepseek.com/v1")
    results = []

    for case in payload["cases"]:
        case_dir = _safe_work_subdir(payload["workDir"], case["id"])
        if case_dir.exists():
            shutil.rmtree(case_dir)
        case_dir.mkdir(parents=True, exist_ok=True)
        ws = case_dir / ".reme"

        cfg = _configure_app_dict(
            str(ws),
            plugins=["lme"],
            embedding_url=payload.get("embeddingUrl"),
            embedding_dims=int(payload.get("embeddingDims", 384)),
            llm_model=llm_model,
            llm_base_url=llm_base_url,
            llm_api_key=api_key,
            enable_dream=True,
            index_sessions=bool(payload.get("indexSessions", True)),
        )
        telemetry = _empty_telemetry()
        phase_ref = ["ingest"]
        phase_outputs = []
        case_error = None
        app = None
        started = False
        try:
            app = Application(**cfg)
            await app.start()
            started = True
            _install_llm_meter(app, telemetry, phase_ref)
            for p_idx, phase in enumerate(case["phases"]):
                day_str = f"2026-11-{10 + p_idx:02d}"
                formatted = []
                for t_idx, turn in enumerate(phase["turns"]):
                    ts = f"{day_str}T10:{t_idx * 5:02d}:00"
                    formatted.append({"name": "user", "role": "user", "content": turn["user"], "created_at": ts})
                    formatted.append({"name": "assistant", "role": "assistant", "content": turn["assistant"], "created_at": ts})

                phase_ref[0] = "ingest"
                t_ing = time.perf_counter()
                _require_job_success(
                    await app.run_job(
                        "auto_memory",
                        messages=formatted,
                        session_id=f"{case['id']}-{phase['id']}",
                        date=day_str,
                    ),
                    f"auto_memory({phase['id']})",
                )
                _require_job_success(await app.run_job("index_update"), f"index_update/ingest({phase['id']})")
                telemetry["ingestMs"] += (time.perf_counter() - t_ing) * 1000.0

                phase_ref[0] = "dream"
                t_dr = time.perf_counter()
                _require_job_success(
                    await app.run_job("auto_dream", date=day_str, scan_days=2, max_units=5),
                    f"auto_dream({phase['id']})",
                )
                _require_job_success(await app.run_job("index_update"), f"index_update/dream({phase['id']})")
                _require_job_success(await app.run_job("digest_update"), f"digest_update({phase['id']})")
                telemetry["dreamMs"] += (time.perf_counter() - t_dr) * 1000.0

                # Also capture raw search hits + agentic answer
                search_resp = _require_job_success(
                    await app.run_job("search", query=phase["recallQuery"], limit=5),
                    f"search({phase['id']})",
                )
                hits = _extract_hits_from_search_response(search_resp, {})

                phase_ref[0] = "answer"
                t_ans = time.perf_counter()
                ans_resp = _require_job_success(
                    await app.run_job(
                        "agentic_answer",
                        query=phase["recallQuery"],
                        query_time=f"{day_str}T23:30:00",
                    ),
                    f"agentic_answer({phase['id']})",
                )
                telemetry["answerMs"] += (time.perf_counter() - t_ans) * 1000.0

                phase_outputs.append({
                    "phaseId": phase["id"],
                    "recallQuery": phase["recallQuery"],
                    "recallSnippetCount": len(hits),
                    "answer": str(ans_resp.answer or "").strip(),
                })
        except Exception as exc:
            case_error = f"{type(exc).__name__}: {exc}"
        finally:
            stats = _workspace_stats(ws)
            if app is not None and started:
                try:
                    await app.close()
                except Exception:
                    pass

        results.append({
            "caseId": case["id"],
            "phases": phase_outputs,
            "workspace": stats,
            "telemetry": telemetry,
            **({"error": case_error} if case_error else {}),
        })
    return {"cases": results}


async def _run_one_lme_item(item: dict[str, Any], payload: dict[str, Any], api_key: str) -> dict[str, Any]:
    from reme import Application

    qid = item["question_id"]
    item_dir = _safe_work_subdir(payload["workDir"], qid)
    if item_dir.exists():
        shutil.rmtree(item_dir)
    item_dir.mkdir(parents=True, exist_ok=True)
    ws = item_dir / ".reme"

    enable_dream = bool(payload.get("enableDream", False))
    cfg = _configure_app_dict(
        str(ws),
        plugins=["lme"],
        embedding_url=payload.get("embeddingUrl"),
        embedding_dims=int(payload.get("embeddingDims", 384)),
        llm_model=payload.get("llmModel", "deepseek-flash"),
        llm_base_url=payload.get("llmBaseUrl", "https://api.deepseek.com/v1"),
        llm_api_key=api_key,
        enable_dream=enable_dream,
        index_sessions=bool(payload.get("indexSessions", True)),
    )
    telemetry = _empty_telemetry()
    phase_ref = ["ingest"]
    sessions_ingested = 0
    dream_triggers = 0
    answer = ""
    err = None
    sessions = item["sessions"]
    app = None
    started = False
    try:
        app = Application(**cfg)
        await app.start()
        started = True
        _install_llm_meter(app, telemetry, phase_ref)
        prev_date = None
        dreamed_dates: set[str] = set()
        for sess in sessions:
            date_str = sess["dateStr"]
            if enable_dream and prev_date is not None and prev_date != date_str and prev_date not in dreamed_dates:
                phase_ref[0] = "dream"
                t_dr = time.perf_counter()
                _require_job_success(
                    await app.run_job("auto_dream", date=prev_date, scan_days=2, max_units=5),
                    f"auto_dream({prev_date})",
                )
                _require_job_success(await app.run_job("index_update"), f"index_update/dream({prev_date})")
                telemetry["dreamMs"] += (time.perf_counter() - t_dr) * 1000.0
                dreamed_dates.add(prev_date)
                dream_triggers += 1

            formatted = [
                {
                    "name": m["role"],
                    "role": m["role"],
                    "content": m["content"],
                    "created_at": sess["isoStr"],
                }
                for m in sess["messages"]
            ]
            phase_ref[0] = "ingest"
            t_ing = time.perf_counter()
            _require_job_success(
                await app.run_job(
                    "auto_memory",
                    messages=formatted,
                    session_id=sess["sessionId"],
                    date=date_str,
                ),
                f"auto_memory({sess['sessionId']})",
            )
            _require_job_success(await app.run_job("index_update"), f"index_update/ingest({sess['sessionId']})")
            telemetry["ingestMs"] += (time.perf_counter() - t_ing) * 1000.0
            sessions_ingested += 1
            prev_date = date_str

        if enable_dream and prev_date is not None and prev_date not in dreamed_dates:
            phase_ref[0] = "dream"
            t_dr = time.perf_counter()
            _require_job_success(
                await app.run_job("auto_dream", date=prev_date, scan_days=2, max_units=5),
                f"auto_dream({prev_date})",
            )
            _require_job_success(await app.run_job("index_update"), f"index_update/dream({prev_date})")
            telemetry["dreamMs"] += (time.perf_counter() - t_dr) * 1000.0
            dreamed_dates.add(prev_date)
            dream_triggers += 1

        _require_job_success(await app.run_job("digest_update"), "digest_update")

        phase_ref[0] = "answer"
        t_ans = time.perf_counter()
        ans_resp = _require_job_success(
            await app.run_job(
                "agentic_answer",
                query=item["question"],
                query_time=item["queryTimeIso"],
            ),
            "agentic_answer",
        )
        telemetry["answerMs"] += (time.perf_counter() - t_ans) * 1000.0
        answer = str(ans_resp.answer or "").strip()
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
    finally:
        stats = _workspace_stats(ws)
        if app is not None and started:
            try:
                await app.close()
            except Exception:
                pass

    return {
        "questionId": qid,
        "answer": answer,
        "sessionsIngested": sessions_ingested,
        "dreamTriggers": dream_triggers,
        "workspace": stats,
        "telemetry": telemetry,
        **({"error": err} if err else {}),
    }


async def cmd_lme_eval(payload: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ["DEEPSEEK_API_KEY"].strip()
    concurrency = max(1, int(payload.get("concurrency", 3)))
    sem = asyncio.Semaphore(concurrency)

    async def bounded(item: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            print(f"[reme-lme] starting {item['question_id']} ({item['question_type']}, {len(item['sessions'])} sessions)", file=sys.stderr, flush=True)
            res = await _run_one_lme_item(item, payload, api_key)
            print(f"[reme-lme] finished {item['question_id']} err={res.get('error', 'none')}", file=sys.stderr, flush=True)
            return res

    results = await asyncio.gather(*(bounded(item) for item in payload["items"]))
    return {"items": list(results)}


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["offline-eval", "scale-bench", "scale-bench-point", "chinese-eval", "lme-eval"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    if args.command == "offline-eval":
        result = await cmd_offline_eval(payload)
    elif args.command == "scale-bench":
        result = await cmd_scale_bench(payload)
    elif args.command == "scale-bench-point":
        result = await cmd_scale_bench_point(payload)
    elif args.command == "chinese-eval":
        result = await cmd_chinese_eval(payload)
    else:
        result = await cmd_lme_eval(payload)

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
