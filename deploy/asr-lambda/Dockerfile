# Build from the project root:
#   docker build --platform linux/amd64 -f deploy/asr-lambda/Dockerfile \
#     --secret id=hf_token,env=HF_TOKEN -t ai-speech-asr .
# python:3.12+ images are Amazon Linux 2023 (glibc 2.34). The 3.11 image is Amazon Linux 2, which has
# no dnf and a glibc too old for current torch/onnxruntime wheels.
FROM public.ecr.aws/lambda/python:3.12

# static ffmpeg (Amazon Linux has no ffmpeg package). Downloaded and unpacked with Python so the
# image needs no package manager (the Lambda base image only has microdnf).
RUN python -c "import io,tarfile,urllib.request; \
data=urllib.request.urlopen('https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz', timeout=300).read(); \
t=tarfile.open(fileobj=io.BytesIO(data), mode='r:xz'); \
m=next(x for x in t.getmembers() if x.name.endswith('/ffmpeg')); \
open('/usr/local/bin/ffmpeg','wb').write(t.extractfile(m).read())" && \
    chmod +x /usr/local/bin/ffmpeg && ffmpeg -version | head -1

# torch + torchaudio together from the CPU index (from PyPI torchaudio would pull the multi-GB CUDA torch)
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu
COPY deploy/asr-lambda/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/asr/indic_asr.py deploy/asr-lambda/app.py deploy/asr-lambda/download_models.py ${LAMBDA_TASK_ROOT}/

# IndicConformer is gated: accept its terms on Hugging Face and pass a token as a build secret
ENV HF_HUB_CACHE=/opt/models/hf-cache HF_HOME=/opt/models/hf-home
RUN --mount=type=secret,id=hf_token HF_TOKEN=$(cat /run/secrets/hf_token) python download_models.py
# Lambda's filesystem is read-only except /tmp; the models are only read from here
# IndicConformer's model code (trust_remote_code) is copied to HF_MODULES_CACHE when loaded, so that must be in /tmp.
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 WHISPER_CACHE=/opt/models/whisper HF_MODULES_CACHE=/tmp/hf_modules

CMD ["app.handler"]
