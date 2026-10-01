#!/bin/bash
# Runs ON the EC2 server. Sent by .github/workflows/deploy.yml through SSM Run Command, which
# prepends: AWS_REGION, ECR_REGISTRY, APP_IMAGE, PARAMETER_NAME, SITE_DOMAIN.
#
#   browser ──HTTPS──► ai-speech-caddy (:80/:443, Let's Encrypt) ──► ai-speech-web (:5055, private network)
#
# HTTPS is required: browsers only allow the microphone (live recording) on secure pages.
set -euo pipefail

while [ ! -f /var/lib/cloud/instance/boot-finished ]; do sleep 5; done
systemctl is-active --quiet docker

DIR=/opt/ai-speech
mkdir -p "$DIR/approved" "$DIR/output"
cd "$DIR"

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"
aws ssm get-parameter --region "$AWS_REGION" --name "$PARAMETER_NAME" --with-decryption \
  --query Parameter.Value --output text > .env
chmod 600 .env

# `cat >` keeps the same file (inode), so the running Caddy container sees the update on reload
cat > Caddyfile <<CADDY
$SITE_DOMAIN {
	encode gzip
	reverse_proxy ai-speech-web:5055
}
CADDY

docker network inspect ai-speech >/dev/null 2>&1 || docker network create ai-speech

PREV="$(docker inspect --format '{{.Config.Image}}' ai-speech-web 2>/dev/null || true)"
docker pull "$APP_IMAGE"

start_app() {
  docker rm -f ai-speech-web >/dev/null 2>&1 || true
  docker run -d --name ai-speech-web --restart unless-stopped --network ai-speech \
    --env-file "$DIR/.env" \
    -v "$DIR/approved:/app/data/approved" -v "$DIR/output:/app/output" \
    "$1" >/dev/null
}

app_healthy() {
  docker exec ai-speech-web node -e \
    "fetch('http://127.0.0.1:5055/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null
}

start_app "$APP_IMAGE"
ok=0
for _ in $(seq 1 30); do
  if app_healthy; then ok=1; break; fi
  sleep 5
done
if [ "$ok" != 1 ]; then
  echo "New version did not become healthy:" >&2
  docker logs --tail 80 ai-speech-web >&2 || true
  if [ -n "$PREV" ] && [ "$PREV" != "$APP_IMAGE" ]; then
    echo "Rolling back to $PREV" >&2
    start_app "$PREV"
  fi
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -qx ai-speech-caddy; then
  docker start ai-speech-caddy >/dev/null
  docker exec ai-speech-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
else
  docker run -d --name ai-speech-caddy --restart unless-stopped --network ai-speech \
    -p 80:80 -p 443:443 \
    -v "$DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v caddy-data:/data -v caddy-config:/config \
    caddy:2 >/dev/null
fi

# End-to-end check through Caddy with the real certificate (first issuance takes a few seconds)
for _ in $(seq 1 36); do
  if curl -fsS -o /dev/null --resolve "$SITE_DOMAIN:443:127.0.0.1" "https://$SITE_DOMAIN/api/config"; then
    echo "Deployed $APP_IMAGE at https://$SITE_DOMAIN"
    docker image prune -af --filter "until=168h" >/dev/null || true
    exit 0
  fi
  sleep 5
done
echo "App is running but HTTPS at https://$SITE_DOMAIN is not answering yet. Caddy log:" >&2
docker logs --tail 60 ai-speech-caddy >&2 || true
exit 1
