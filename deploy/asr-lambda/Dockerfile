# Build from the project root:
#   docker build --platform linux/amd64 -f deploy/asr-lambda/Dockerfile \
#     --secret id=hf_token,env=HF_TOKEN -t ai-speech-asr .
FROM public.ecr.aws/lambda/python:3.11

# static ffmpeg (Amazon Linux has no ffmpeg package)
RUN dnf install -y tar xz && \
    curl -sL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ -C /tmp && \
    mv /tmp/ffmpeg-*-static/ffmpeg /usr/local/bin/ && rm -rf /tmp/ffmpeg-* && dnf clean all

RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY deploy/asr-lambda/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/asr/indic_asr.py deploy/asr-lambda/app.py deploy/asr-lambda/download_models.py ${LAMBDA_TASK_ROOT}/

# IndicConformer is gated: accept its terms on Hugging Face and pass a token as a build secret
ENV HF_HUB_CACHE=/opt/models/hf-cache HF_HOME=/opt/models/hf-home
RUN --mount=type=secret,id=hf_token HF_TOKEN=$(cat /run/secrets/hf_token) python download_models.py
# Lambda's filesystem is read-only except /tmp; the models are only read from here
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 WHISPER_CACHE=/opt/models/whisper

CMD ["app.handler"]
