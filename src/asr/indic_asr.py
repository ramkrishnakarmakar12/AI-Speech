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
  python3 -m pip install onnxruntime==1.20.1 onnx torchaudio

Input must be 16 kHz mono 16-bit WAV (index.ts converts with ffmpeg).
Prints one JSON line: {"text": ..., "model": ..., "device": ...}
"""
import argparse, json, sys, wave


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
    import torch
    from transformers import pipeline
    dtype = torch.float16 if device in ("cuda", "mps") else torch.float32
    asr = pipeline(
        "automatic-speech-recognition",
        model=model_id,
        torch_dtype=dtype,
        device=device,
        chunk_length_s=30,
    )
    out = asr(
        {"raw": audio, "sampling_rate": 16000},
        batch_size=4,
        generate_kwargs={"language": lang, "task": "transcribe"},
    )
    return out["text"].strip()


def run_conformer(model_id, audio, lang, decoding):
    import torch
    from transformers import AutoModel
    model = AutoModel.from_pretrained(model_id, trust_remote_code=True)
    wav = torch.from_numpy(audio).unsqueeze(0)
    # The model works on ~30 s windows best; split long recordings to keep memory flat.
    step = 16000 * 30
    parts = []
    for i in range(0, wav.shape[1], step):
        chunk = wav[:, i : i + step]
        if chunk.shape[1] < 1600:  # <0.1 s
            continue
        parts.append(str(model(chunk, lang, decoding)).strip())
    return " ".join(p for p in parts if p)


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
            device = "cpu (onnxruntime)"
            text = run_conformer(a.model, audio, a.lang, a.decoding)
    except ImportError as e:
        print(json.dumps({"error": f"missing Python package ({e.name}). Run: python3 -m pip install -U transformers torch numpy"
                                    + (" onnxruntime==1.20.1 onnx torchaudio" if engine == "conformer" else "")}))
        sys.exit(2)
    except OSError as e:
        msg = str(e)
        if "gated" in msg.lower() or "401" in msg or "403" in msg:
            msg = f"{a.model} is gated: open its Hugging Face page, accept the terms, then run `hf auth login`. ({msg[:200]})"
        print(json.dumps({"error": msg}))
        sys.exit(3)
    print(json.dumps({"text": text, "model": a.model, "device": device, "engine": engine}, ensure_ascii=False))


if __name__ == "__main__":
    main()
