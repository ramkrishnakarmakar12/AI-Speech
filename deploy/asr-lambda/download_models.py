"""Runs at image build time: bake the models into the image so cold starts don't download."""
import os, sys
sys.path.insert(0, "/var/task")
os.environ["INDIC_HF_CACHE"] = "/opt/models/hf-cache"
from indic_asr import use_plain_file_cache
use_plain_file_cache()  # real files, no symlinks (onnxruntime external-data check)
from transformers import AutoModel
AutoModel.from_pretrained(os.environ.get("INDIC_MODEL", "ai4bharat/indic-conformer-600m-multilingual"),
                          trust_remote_code=True)
from faster_whisper import WhisperModel
WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3-turbo"), device="cpu", compute_type="int8",
             download_root="/opt/models/whisper")
print("models ready")
