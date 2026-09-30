# Speech endpoint on AWS Lambda (production ASR)

The web app calls this endpoint when `.env` has `MODEL_ENV=production` and `PROD_ASR_BACKEND=remote`.
Bengali and Hindi use IndicConformer-600M, English uses faster-whisper large-v3-turbo. You pay only while it runs.

## 1. Build (on any machine with Docker; the Mac mini works)

```bash
cd "AI Speech"                         # project root
export HF_TOKEN=hf_xxx                 # account that accepted the IndicConformer terms
docker build --platform linux/amd64 -f deploy/asr-lambda/Dockerfile \
  --secret id=hf_token,env=HF_TOKEN -t ai-speech-asr .
```

The image is about 6–7 GB; Lambda allows up to 10 GB.

## 2. Push to ECR

```bash
REGION=ap-south-1; ACCT=$(aws sts get-caller-identity --query Account --output text)
aws ecr create-repository --repository-name ai-speech-asr --region $REGION
aws ecr get-login-password --region $REGION | docker login -u AWS --password-stdin $ACCT.dkr.ecr.$REGION.amazonaws.com
docker tag ai-speech-asr $ACCT.dkr.ecr.$REGION.amazonaws.com/ai-speech-asr:latest
docker push $ACCT.dkr.ecr.$REGION.amazonaws.com/ai-speech-asr:latest
```

## 3. Create the function

In the Lambda console, go to Create function, then Container image, and choose the image. Then set:

| Setting | Value |
|---|---|
| Architecture | x86_64 |
| Memory | 10240 MB (this also gives the most vCPUs, about 6) |
| Ephemeral storage | 2048 MB |
| Timeout | 15 min |
| Env vars | `ASR_TOKEN=<long random string>`, optional `INDIC_CHUNK_S=15`, `INDIC_DECODING=rnnt` |
| Function URL | Auth type NONE (the bearer token protects it), or put API Gateway in front |

## 4. Point the app at it (`.env` on the server)

```
MODEL_ENV=production
PROD_ASR_BACKEND=remote
PROD_ASR_REMOTE_URL=https://<id>.lambda-url.ap-south-1.on.aws/
PROD_ASR_REMOTE_TOKEN=<same ASR_TOKEN>
```

Run `npm run check` to confirm it answers.

## Limits and notes

- The request body must be under 6 MB (base64). The app refuses audio over about 5.5 MB, so upload m4a, mp3 or webm, not WAV. The browser recorder already saves webm/opus, about 0.5 MB per minute.
- The first request after idle is a cold start. Loading the models takes about 20–40 s; warm requests skip this.
- A 5-minute visit takes about 1–3 minutes on CPU. Cost is about 10 GB × 120 s ≈ $0.02 per visit (ap-south-1 pricing, check the current rate).
- Always send `language` (bn/hi/en). `auto` works, but Whisper's detection often mistakes Bengali for Hindi.
