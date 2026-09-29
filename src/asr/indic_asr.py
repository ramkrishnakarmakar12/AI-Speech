#!/usr/bin/env python3
"""
Indic speech-to-text with Hugging Face models — called by src/asr/index.ts (ASR_BACKEND=indic).

Two engines:
  whisper    – Whisper fine-tuned on Indian speech, e.g.
               ARTPARK-IISc/whisper-large-v3-vaani-hindi   (Hindi,  Apache-2.0)
               ARTPARK-IISc/whisper-medium-vaani-bengali   (Bengali, MIT)
  conformer  – ai4bharat/indic-conformer-600m-multilingual (22 languages, MIT, gated: accept terms on HF + `hf auth login`)

Install once:
  python3 -m pip install -U transformers torch numpy
  # for IndicConformer additionally:
  python3 -m pip install onnxruntime onnx torchaudio   # no version pin; onnxruntime-gpu does not exist on macOS

Input must be 16 kHz mono 16-bit WAV (index.ts converts with ffmpeg).
Prints one JSON line: {"text": ..., "model": ..., "device": ...}
"""
import argparse, json, os, sys, wave

# onnxruntime + torch on macOS can abort while Python tears them down
# ("libc++abi: ... recursive_mutex lock failed: Invalid argument") AFTER the work is done.
# Models are kept referenced here and the process leaves via os._exit(), which skips those destructors.
_KEEP_ALIVE = []


def hard_exit(code=0):
    sys.stdout.flush(); sys.stderr.flush()
    os._exit(code)


def load_wav(path):
    import numpy as np
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit(json.dumps({"error": "expected 16 kHz mono 16-bit WAV"}))
        pcm = w.readframes(w.getnframes())
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def pick_device():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"  # Apple Silicon GPU
    return "cpu"


def run_whisper(model_id, audio, lang, device):
    """Load the Whisper model classes directly instead of transformers.pipeline().
    pipeline() imports every task module (vision, video, …); one broken optional dependency
    (torchvision, torchcodec, protobuf …) then fails with "Could not import module 'pipeline'"."""
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor
    dtype = torch.float16 if device in ("cuda", "mps") else torch.float32
    processor = WhisperProcessor.from_pretrained(model_id)
    model = WhisperForConditionalGeneration.from_pretrained(model_id, dtype=dtype).to(device).eval()
    step = 16000 * 30  # Whisper's native 30 s window
    parts = []
    for i in range(0, len(audio), step):
        chunk = audio[i : i + step]
        if len(chunk) < 1600:  # <0.1 s
            continue
        feats = processor(chunk, sampling_rate=16000, return_tensors="pt").input_features.to(device, dtype)
        with torch.inference_mode():
            # No no_repeat_ngram_size here: Bengali is split into byte-level tokens, so a 4-token
            # n-gram ban is only 1-2 letters and forced broken UTF-8 (the "�", "¨", "¯" seen in
            # prescription 5). Loops are removed after decoding instead.
            ids = model.generate(feats, language=lang, task="transcribe", num_beams=1, max_new_tokens=440)
        parts.append(collapse_repeats(processor.batch_decode(ids, skip_special_tokens=True)[0].strip()))
    return " ".join(p for p in parts if p)


def collapse_repeats(text):
    """Drop hallucination loops: a phrase (>=4 chars) repeated 3+ times in a row is kept once."""
    import re
    text = re.sub(r"(.{4,80}?)(?:[\s,.।|]*\1){2,}", r"\1", text)
    return text.replace("\ufffd", "").strip()


def root_cause(e):
    """transformers wraps the real import failure; walk the chain to the original message."""
    seen = e
    while (seen.__cause__ or seen.__context__) is not None:
        seen = seen.__cause__ or seen.__context__
    return f"{type(seen).__name__}: {seen}" if seen is not e else str(e)


def use_plain_file_cache():
    """IndicConformer ships ONNX weights as external-data files. Hugging Face's cache stores them as
    symlinks into a shared blobs/ folder, and onnxruntime >= 1.21 rejects external data that resolves
    outside the model folder ("External data path escapes model directory"). The model card pins
    onnxruntime 1.20.1 to dodge this, but that version has no build for Python 3.14.
    Fix: download into the project's own cache (models/hf-cache) as real files, no symlinks.
    Must run before huggingface_hub / transformers are imported."""
    import os
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    cache = os.environ.get("INDIC_HF_CACHE") or os.path.join(root, "models", "hf-cache")
    os.makedirs(cache, exist_ok=True)
    os.environ["HF_HUB_CACHE"] = cache
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    import huggingface_hub.file_download as fd
    fd.are_symlinks_supported = lambda *a, **k: False  # copy files instead of symlinking
    return cache


def split_on_silence(audio, sr=16000, max_s=15.0, search_s=3.0):
    """Cut the recording into <= max_s pieces, placing each cut at the quietest 20 ms frame in the
    last search_s seconds of the window so words are not chopped in half."""
    import numpy as np
    n, maxn, frame = len(audio), int(max_s * sr), int(0.02 * sr)
    cuts, pos = [], 0
    while n - pos > maxn:
        lo, hi = pos + maxn - int(search_s * sr), pos + maxn
        seg = audio[lo:hi]
        k = len(seg) // frame
        energy = (seg[: k * frame].reshape(k, frame) ** 2).mean(axis=1)
        cut = lo + int(np.argmin(energy)) * frame + frame // 2
        cuts.append((pos, cut)); pos = cut
    cuts.append((pos, n))
    return cuts


def run_conformer(model_id, audio, lang, decoding):
    """IndicConformer, piece by piece.
    Prescription 12 showed the model returning (almost) nothing for full 30 s windows while the short
    final piece came out at ~4% CER, so pieces are now <= INDIC_CHUNK_S seconds (default 15), cut at
    silences, and a piece that comes back empty is retried with the other decoder (rnnt <-> ctc)."""
    import os, torch
    from transformers import AutoModel
    model = AutoModel.from_pretrained(model_id, trust_remote_code=True)
    _KEEP_ALIVE.append(model)  # never let Python destroy it; see hard_exit()
    max_s = float(os.environ.get("INDIC_CHUNK_S", "15"))
    other = "ctc" if decoding == "rnnt" else "rnnt"

    def decode(x, how):
        out = model(x, lang, how)
        if isinstance(out, (list, tuple)):
            out = " ".join(map(str, out))
        return str(out).strip()

    parts = []
    for a, b in split_on_silence(audio, max_s=max_s):
        if b - a < 1600:  # <0.1 s
            continue
        x = torch.from_numpy(audio[a:b].copy()).unsqueeze(0)
        text, used = decode(x, decoding), decoding
        secs = (b - a) / 16000
        if len(text) < secs * 0.5:  # near-empty for its length -> try the other decoder
            alt = decode(x, other)
            if len(alt) > len(text):
                text, used = alt, other
        print(f"[indic] {a/16000:6.1f}-{b/16000:6.1f}s {used}: {len(text)} chars", file=sys.stderr)
        if text:
            parts.append(text)
    return " ".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--lang", required=True, help="ISO code: hi, bn, …")
    ap.add_argument("--model", required=True)
    ap.add_argument("--engine", choices=["whisper", "conformer"], default="")
    ap.add_argument("--decoding", choices=["ctc", "rnnt"], default="rnnt")
    a = ap.parse_args()
    engine = a.engine or ("conformer" if "conformer" in a.model.lower() else "whisper")

    try:
        audio = load_wav(a.audio)
        device = pick_device()
        if engine == "whisper":
            text = run_whisper(a.model, audio, a.lang, device)
        else:
            use_plain_file_cache()
            device = "cpu (onnxruntime)"
            text = run_conformer(a.model, audio, a.lang, a.decoding)
    except ImportError as e:
        # e.name is None when transformers itself raises ImportError (e.g. "requires the PyTorch library"),
        # so always include the real message and the interpreter that ran this script.
        pkg = e.name or "see details"
        print(json.dumps({"error": f"missing Python package ({pkg}) in {sys.executable}: {root_cause(e)[:400]} "
                                    f"-> Run: {sys.executable} -m pip install -U transformers torch numpy"
                                    + (" onnxruntime onnx torchaudio" if engine == "conformer" else "")}))
        hard_exit(2)
    except OSError as e:
        msg = str(e)
        if "gated" in msg.lower() or "401" in msg or "403" in msg:
            msg = f"{a.model} is gated: open its Hugging Face page, accept the terms, then run `hf auth login`. ({msg[:200]})"
        print(json.dumps({"error": msg}))
        hard_exit(3)
    print(json.dumps({"text": text, "model": a.model, "device": device, "engine": engine}, ensure_ascii=False))
    hard_exit(0)


if __name__ == "__main__":
    main()
