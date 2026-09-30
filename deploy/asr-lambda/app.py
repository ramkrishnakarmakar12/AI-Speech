"""AWS Lambda speech endpoint for AI Speech (ASR_BACKEND=remote / PROD_ASR_BACKEND=remote).

Contract (matches remoteAsr() in src/asr/index.ts):
  POST  {"audio_b64": "...", "filename": "visit.m4a", "language": "bn" | "hi" | "en" | "auto"}
  Header Authorization: Bearer <ASR_TOKEN>
  200   {"text": "...", "language": "bn", "model": "...", "duration_sec": 312.4}
  4xx/5xx {"error": "..."}

bn / hi  -> IndicConformer-600M (RNNT, 15 s silence-aligned pieces, CTC fallback): the setup that
            scored best in the evaluation reports.
en/auto  -> faster-whisper (large-v3-turbo, int8 on CPU). "auto" re-runs IndicConformer if Whisper
            detects bn/hi. Auto-detect is unreliable for Bengali; the app should send the language.
"""
import base64, json, os, subprocess, sys, tempfile, time, wave

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from indic_asr import split_on_silence  # same cutter as the Mac

TOKEN = os.environ.get("ASR_TOKEN", "")
INDIC_ID = os.environ.get("INDIC_MODEL", "ai4bharat/indic-conformer-600m-multilingual")
WHISPER_ID = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
CHUNK_S = float(os.environ.get("INDIC_CHUNK_S", "15"))
DECODING = os.environ.get("INDIC_DECODING", "rnnt")
_models = {}  # kept across warm invocations


def _resp(code, body):
    return {"statusCode": code, "headers": {"content-type": "application/json"},
            "body": json.dumps(body, ensure_ascii=False)}


def _to_wav16k(src):
    dst = src + ".16k.wav"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", src,
                    "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", dst], check=True)
    with wave.open(dst, "rb") as w:
        pcm = w.readframes(w.getnframes())
    os.remove(dst)
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def _indic():
    if "indic" not in _models:
        from transformers import AutoModel
        _models["indic"] = AutoModel.from_pretrained(INDIC_ID, trust_remote_code=True)
    return _models["indic"]


def _whisper():
    if "whisper" not in _models:
        from faster_whisper import WhisperModel
        _models["whisper"] = WhisperModel(WHISPER_ID, device="cpu", compute_type="int8",
                                          download_root=os.environ.get("WHISPER_CACHE", "/opt/models/whisper"))
    return _models["whisper"]


def conformer(audio, lang):
    import torch
    model, other = _indic(), ("ctc" if DECODING == "rnnt" else "rnnt")

    def decode(x, how):
        out = model(x, lang, how)
        return (" ".join(map(str, out)) if isinstance(out, (list, tuple)) else str(out)).strip()

    parts = []
    for a, b in split_on_silence(audio, max_s=CHUNK_S):
        if b - a < 1600:
            continue
        x = torch.from_numpy(audio[a:b].copy()).unsqueeze(0)
        text = decode(x, DECODING)
        if len(text) < (b - a) / 16000 * 0.5:
            alt = decode(x, other)
            text = alt if len(alt) > len(text) else text
        if text:
            parts.append(text)
    return " ".join(parts)


def whisper(audio, lang):
    segs, info = _whisper().transcribe(audio, language=None if lang == "auto" else lang,
                                       vad_filter=True, condition_on_previous_text=False)
    return " ".join(s.text.strip() for s in segs).strip(), info.language


def handler(event, context):
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    if TOKEN and headers.get("authorization", "") != f"Bearer {TOKEN}":
        return _resp(401, {"error": "bad or missing bearer token"})
    try:
        raw = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode()
        req = json.loads(raw)
        data = base64.b64decode(req["audio_b64"])
    except Exception as e:
        return _resp(400, {"error": f"expected JSON with audio_b64: {e}"})
    lang = str(req.get("language") or "auto").strip().lower()
    lang = {"bengali": "bn", "bangla": "bn", "hindi": "hi", "english": "en"}.get(lang, lang)
    if lang not in ("bn", "hi", "en"):
        lang = "auto"
    ext = os.path.splitext(req.get("filename") or "a.webm")[1] or ".webm"
    t0 = time.time()
    with tempfile.NamedTemporaryFile(suffix=ext, dir="/tmp", delete=False) as f:
        f.write(data)
    try:
        audio = _to_wav16k(f.name)
        dur = len(audio) / 16000
        if lang in ("bn", "hi"):
            text, model = conformer(audio, lang), INDIC_ID
        else:
            text, detected = whisper(audio, lang)
            model = f"faster-whisper/{WHISPER_ID}"
            if lang == "auto" and detected in ("bn", "hi"):
                text, model = conformer(audio, detected), INDIC_ID
            lang = detected if lang == "auto" else lang
        print(f"[asr] {lang} {dur:.0f}s audio in {time.time() - t0:.0f}s via {model}")
        return _resp(200, {"text": text, "language": lang, "model": model, "duration_sec": round(dur, 1)})
    except subprocess.CalledProcessError:
        return _resp(400, {"error": "could not decode the audio file (ffmpeg failed)"})
    except Exception as e:
        return _resp(500, {"error": f"{type(e).__name__}: {e}"})
    finally:
        os.remove(f.name)
