#!/bin/bash
# Runs ON an existing server that already has nginx (prod: the LEF server). Sent by
# .github/workflows/deploy.yml through SSM Run Command, which prepends:
#   AWS_REGION ECR_REGISTRY APP_IMAGE PARAMETER_NAME SITE_DOMAIN ALLOWED_CIDRS HOST_PORT CERTBOT_EMAIL
#
#   browser ──HTTPS──► nginx (existing; new server block for $SITE_DOMAIN only)
#                        └─► ai-speech-web container (host network, listening on 127.0.0.1:$HOST_PORT only)
#
# Other sites on this server (lef.paninieight.com…) are not touched: this script only writes its own
# nginx file, its own certificate and its own container, and refuses to reload nginx if `nginx -t` fails.
set -euo pipefail

HOST_PORT="${HOST_PORT:-5055}"
DIR=/opt/ai-speech
WEBROOT=/var/www/ai-speech-acme
CERT_DIR="/etc/letsencrypt/live/$SITE_DOMAIN"

log() { echo "[ai-speech] $*"; }
pm_install() {
  if command -v dnf >/dev/null; then dnf install -y "$@"
  elif command -v yum >/dev/null; then yum install -y "$@"
  else
    # NEEDRESTART_SUSPEND: never let apt restart services mid-deploy (it would kill the SSM agent running this)
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get update -y &&
      DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get install -y "$@"
  fi
}

# SSM gives a minimal PATH; snap and the AWS CLI installer live here
export PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin:$PATH"

# ---------- AWS CLI v2 (Ubuntu images don't ship it; Amazon Linux does) ----------
if ! command -v aws >/dev/null; then
  log "installing AWS CLI v2"
  command -v curl >/dev/null || pm_install curl
  command -v unzip >/dev/null || pm_install unzip
  tmp="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$tmp/awscliv2.zip"
  unzip -q "$tmp/awscliv2.zip" -d "$tmp"
  "$tmp/aws/install" --update
  rm -rf "$tmp"
fi
aws --version

command -v nginx >/dev/null || { echo "nginx is not installed on this server" >&2; exit 1; }
systemctl is-active --quiet nginx || { echo "nginx is not running (systemctl status nginx)" >&2; exit 1; }

# ---------- Docker ----------
if ! command -v docker >/dev/null; then
  log "installing Docker"
  if command -v apt-get >/dev/null; then pm_install docker.io; else pm_install docker; fi
fi
systemctl enable --now docker

# ---------- settings + image ----------
mkdir -p "$DIR/approved" "$DIR/output"
cd "$DIR"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"
aws ssm get-parameter --region "$AWS_REGION" --name "$PARAMETER_NAME" --with-decryption \
  --query Parameter.Value --output text > .env
chmod 600 .env

# the host port must be free or already ours
if ss -ltn "( sport = :$HOST_PORT )" | grep -q LISTEN && \
   [ "$(docker inspect --format '{{.State.Running}}' ai-speech-web 2>/dev/null)" != "true" ]; then
  echo "Port $HOST_PORT is used by another program on this server. Set the APP_HOST_PORT variable to a free port." >&2
  exit 1
fi

PREV="$(docker inspect --format '{{.Config.Image}}' ai-speech-web 2>/dev/null || true)"
docker pull "$APP_IMAGE"

start_app() {
  docker rm -f ai-speech-web >/dev/null 2>&1 || true
  # host network: the container reaches the instance metadata service (IAM role → Bedrock) without
  # changing this server's IMDS hop limit; LISTEN_HOST=127.0.0.1 keeps the app off the public interface.
  docker run -d --name ai-speech-web --restart unless-stopped --network host \
    --env-file "$DIR/.env" -e LISTEN_HOST=127.0.0.1 -e PORT="$HOST_PORT" \
    -v "$DIR/approved:/app/data/approved" -v "$DIR/output:/app/output" \
    "$1" >/dev/null
}
app_healthy() { curl -fsS -o /dev/null "http://127.0.0.1:$HOST_PORT/api/config"; }

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
log "app healthy on 127.0.0.1:$HOST_PORT"

# ---------- nginx server block (our own file only) ----------
if [ -d /etc/nginx/sites-available ] && grep -q "sites-enabled" /etc/nginx/nginx.conf; then
  CONF=/etc/nginx/sites-available/ai-speech.conf
  LINK=/etc/nginx/sites-enabled/ai-speech.conf
else
  CONF=/etc/nginx/conf.d/ai-speech.conf
  LINK=""
fi
mkdir -p "$WEBROOT"

ALLOW=""
for c in $ALLOWED_CIDRS; do ALLOW="$ALLOW        allow $c;\n"; done

write_conf() { # $1 = with_tls (0/1)
  local backup=""
  [ -f "$CONF" ] && backup="$(cat "$CONF")"
  {
    cat <<NGINX
# Managed by AI Speech deploy (deploy/app/remote-deploy-nginx.sh). Do not edit by hand.
server {
    listen 80;
    server_name $SITE_DOMAIN;

    location /.well-known/acme-challenge/ {
        root $WEBROOT;
    }
NGINX
    if [ "$1" = 1 ]; then
      cat <<'NGINX'
    location / {
        return 301 https://$host$request_uri;
    }
}
NGINX
      cat <<NGINX

server {
    listen 443 ssl;
    http2 on;
    server_name $SITE_DOMAIN;

    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # audio uploads and slow speech/LLM steps
    client_max_body_size 50m;
    proxy_read_timeout   900s;
    proxy_send_timeout   900s;

    location / {
        # only the clinic's IPs (ALLOWED_CIDR_BLOCKS) and this server itself
        allow 127.0.0.1;
$(printf "%b" "$ALLOW")
        deny all;

        proxy_pass http://127.0.0.1:$HOST_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
NGINX
    else
      cat <<'NGINX'
    location / {
        return 503;
    }
}
NGINX
    fi
  } > "$CONF"
  [ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
  if ! nginx -t 2>/tmp/ai-speech-nginx-test; then
    # `http2 on;` needs nginx >= 1.25.1; older nginx uses `listen 443 ssl http2;`
    if grep -q 'unknown directive "http2"' /tmp/ai-speech-nginx-test; then
      sed -i -e '/^    http2 on;$/d' -e 's/listen 443 ssl;/listen 443 ssl http2;/' "$CONF"
    fi
    if ! nginx -t; then
      echo "nginx config test failed; restoring the previous AI Speech config. Other sites are unaffected." >&2
      if [ -n "$backup" ]; then printf '%s\n' "$backup" > "$CONF"; else rm -f "$CONF" ${LINK:+"$LINK"}; fi
      exit 1
    fi
  fi
  systemctl reload nginx
}

# ---------- HTTPS certificate (Let's Encrypt, webroot: nginx keeps running) ----------
if ! command -v certbot >/dev/null; then
  log "installing certbot"
  if command -v apt-get >/dev/null; then
    pm_install certbot
  else
    pm_install python3
    python3 -m venv /opt/certbot
    /opt/certbot/bin/pip install --quiet --upgrade pip certbot
    ln -sf /opt/certbot/bin/certbot /usr/local/bin/certbot
  fi
fi
CERTBOT="$(command -v certbot)"

if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  write_conf 0
  log "requesting a certificate for $SITE_DOMAIN"
  if [ -n "${CERTBOT_EMAIL:-}" ]; then EMAIL=(-m "$CERTBOT_EMAIL"); else EMAIL=(--register-unsafely-without-email); fi
  "$CERTBOT" certonly --webroot -w "$WEBROOT" -d "$SITE_DOMAIN" \
    --non-interactive --agree-tos "${EMAIL[@]}" \
    --deploy-hook "systemctl reload nginx"
fi
write_conf 1

# automatic renewal (twice a day; certbot only renews when < 30 days remain)
if ! systemctl list-timers --all 2>/dev/null | grep -q certbot && [ ! -f /etc/cron.d/certbot ]; then
  cat > /etc/systemd/system/ai-speech-certbot-renew.service <<UNIT
[Unit]
Description=Renew Let's Encrypt certificates (AI Speech)
[Service]
Type=oneshot
ExecStart=$CERTBOT renew --quiet
UNIT
  cat > /etc/systemd/system/ai-speech-certbot-renew.timer <<'UNIT'
[Unit]
Description=Renew Let's Encrypt certificates twice a day
[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now ai-speech-certbot-renew.timer
fi

# ---------- end-to-end check through nginx with the real certificate ----------
for _ in $(seq 1 12); do
  if curl -fsS -o /dev/null --resolve "$SITE_DOMAIN:443:127.0.0.1" "https://$SITE_DOMAIN/api/config"; then
    log "deployed $APP_IMAGE at https://$SITE_DOMAIN"
    # remove only older AI Speech images (other apps' images on this server are left alone)
    docker images --format '{{.Repository}}:{{.Tag}}' | grep "^${APP_IMAGE%:*}:" | grep -vxF "$APP_IMAGE" \
      | xargs -r docker rmi >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 5
done
echo "App is running but https://$SITE_DOMAIN is not answering through nginx." >&2
nginx -T 2>/dev/null | grep -n "server_name.*$SITE_DOMAIN" >&2 || true
exit 1
