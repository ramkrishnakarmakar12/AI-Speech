#!/usr/bin/env python3
"""Qwen3-ASR on Apple Silicon (MLX) — called by src/asr/index.ts.
Install once:  pip install -U mlx-qwen3-asr
Prints one JSON object: {"text": ..., "language": ...}
"""
import argparse, inspect, json, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="Qwen/Qwen3-ASR-1.7B")
    ap.add_argument("--context-file", default="")
    ap.add_argument("--language", default="")
    a = ap.parse_args()
    try:
        from mlx_qwen3_asr import transcribe
    except ImportError:
        print(json.dumps({"error": "mlx-qwen3-asr is not installed. Run: pip install -U mlx-qwen3-asr"}))
        sys.exit(2)

    params = inspect.signature(transcribe).parameters
    takes_any = any(p.kind == p.VAR_KEYWORD for p in params.values())
    kw = {"model": a.model}
    if a.context_file:
        with open(a.context_file, encoding="utf-8") as f:
            ctx = f.read().strip()
        if ctx and ("context" in params or takes_any):
            kw["context"] = ctx
    if a.language and ("language" in params or takes_any):
        kw["language"] = a.language
    r = transcribe(a.audio, **kw)
    text = getattr(r, "text", r if isinstance(r, str) else str(r))
    print(json.dumps({"text": text, "language": getattr(r, "language", None)}, ensure_ascii=False))

if __name__ == "__main__":
    main()
