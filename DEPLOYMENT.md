# CI/CD deployment

GitHub Actions runs type checking and tests before deploying. Only pushes to `main` deploy, using the GitHub `prod` environment and production AWS resources. No other branch is built or deployed. The Node app runs in Docker on EC2; the speech endpoint is deployed as a Lambda container image.

## One-time setup

1. Create an S3 bucket for Terraform state outside this stack. Enable bucket versioning, block public access, and default encryption. The deploy role needs state-object access and permission to use S3 lock files.
2. Configure an AWS IAM role for GitHub Actions OIDC. Trust only this repository's `main` branch through the GitHub `prod` environment; grant it permissions to manage this stack, push to ECR, invoke SSM Run Command, and read Terraform state. Store its ARN as the `AWS_DEPLOY_ROLE_ARN` secret in the `prod` environment. No long-lived AWS access keys are used.
3. Create a GitHub Environment named `prod`, restrict it to `main`, and require reviewer approval. Set these variables in that environment:

   | Variable | Example |
   | --- | --- |
   | `AWS_REGION` | `ap-south-1` |
   | `TF_STATE_BUCKET` | Your pre-created state bucket name |
   | `ALLOWED_CIDR_BLOCKS` | `["198.51.100.10/32"]` as JSON; use clinic/VPN public IPs |
   | `LLM_MODEL` | A Bedrock model or inference profile ID enabled in that region |
   | `DOMAIN` (optional) | `rx.example.com`, with its DNS A record pointing at the Elastic IP. Leave unset to use `<elastic-ip>.sslip.io` |

4. Add `HF_TOKEN` as a secret in `prod`. The account behind this token must have accepted the Hugging Face terms for `ai4bharat/indic-conformer-600m-multilingual`; the image build downloads gated model weights.
5. Ensure Bedrock model access is enabled in the selected region. The EC2 instance role receives Bedrock invoke permissions; the application config and generated ASR bearer token are stored in SSM Parameter Store as a `SecureString` encrypted with a dedicated KMS key.
6. Push to `main`. The initial run creates ECR repositories before building and pushing images; Terraform then provisions the rest of the infrastructure and the app is rolled out through Systems Manager.

## Prod: on the existing LEF server, at rx-lef.paninieight.com

Prod runs as one more Docker container on the existing LEF EC2, behind that server's nginx, on its own subdomain. The LEF site keeps running as before.

Set these extra variables in the GitHub `prod` environment:

| Variable | Value |
| --- | --- |
| `EXISTING_INSTANCE_ID` | `i-03f02b13190d592e0` |
| `DOMAIN` | `rx-lef.paninieight.com` |
| `ROUTE53_ZONE` | `paninieight.com` |
| `CERTBOT_EMAIL` (optional) | email address for Let's Encrypt expiry notices |
| `APP_HOST_PORT` (optional) | local port for the app container, default `5055`; change it only if something on the server already uses 5055 |

### What each deploy does

- **Terraform**
  - Creates the `rx-lef` A record in Route 53, pointing at the LEF server's public IP.
  - Adds an inline policy `ai-speech-prod-runtime` to the server's existing IAM role. The policy lets the server pull the app image, read its settings, call Bedrock and run the SSM agent. If the server has no role yet, Terraform attaches a new `ai-speech-prod-ec2` role instead.
  - Never creates, replaces or reconfigures the server, its security group or its IP.
- **`deploy/app/remote-deploy-nginx.sh`, run on the server over SSM**
  - Installs Docker if it's missing, and runs the app on `127.0.0.1:<APP_HOST_PORT>`, so it isn't reachable from outside.
  - Writes **its own** nginx file, `ai-speech.conf`, with:
    - HTTPS
    - the `ALLOWED_CIDR_BLOCKS` allow-list
    - 50 MB uploads
    - 15-minute timeouts
  - Gets a Let's Encrypt certificate for the subdomain with certbot (webroot, so nginx keeps running) and sets up automatic renewal.
  - Runs `nginx -t` before every reload and restores its previous file if the test fails. LEF's nginx files are never edited.
  - Removes only older AI Speech images.

### Before the first deploy, the AWS admin needs to

1. Find the LEF server's role. Go to **EC2**, open the instance `i-03f02b13190d592e0`, then the **Security** tab, then **IAM Role**. If it shows none, skip to step 3.
2. Add this statement to the `ai-speech-github-deploy` role's inline policy `ai-speech-iam`, replacing `<LEF_ROLE_NAME>`:
   ```json
   {
     "Effect": "Allow",
     "Action": ["iam:GetRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies"],
     "Resource": "arn:aws:iam::170079868967:role/<LEF_ROLE_NAME>"
   }
   ```
3. Add this statement too. Terraform needs it to read which role the server uses:
   ```json
   { "Effect": "Allow", "Action": "iam:GetInstanceProfile", "Resource": "arn:aws:iam::170079868967:instance-profile/*" }
   ```
4. Make sure the LEF server's **security group** allows inbound **80 and 443 from 0.0.0.0/0**. Port 80 is needed for Let's Encrypt; access to the app itself is limited in nginx.
5. Make sure the LEF server has an **Elastic IP**. Without one its IP changes on stop/start, and the next deploy would update the DNS record.

### Switching to a dedicated server later

Clear `EXISTING_INSTANCE_ID`. Terraform then creates its own EC2, Elastic IP and security group, with Caddy for HTTPS. `ROUTE53_ZONE` and `DOMAIN` still work in that mode.

## How the site is served (dedicated-server mode)

- **Elastic IP.** The server keeps a fixed public address, even across stop/start or replacement. Terraform outputs it as `public_ip`.
- **HTTPS.** Caddy runs in front of the app (`deploy/app/remote-deploy.sh`) and gets a free Let's Encrypt certificate. Browsers only allow the microphone on HTTPS pages, so **live recording works only through this HTTPS address**. Without `DOMAIN`, the hostname is `<elastic-ip-with-dashes>.sslip.io`, which needs no DNS setup. The deploy summary shows the exact URL (`app_url`).
- **Access.** Port 443 is open only to `ALLOWED_CIDR_BLOCKS`. Port 80 is open to everyone because Let's Encrypt must reach it to issue the certificate. On port 80, Caddy answers only that challenge and redirects everything else to HTTPS. The app container itself is not exposed; it sits on a private Docker network behind Caddy.
- **No login.** The web app has no login/authentication, so IP filtering is its only access control. Keep `ALLOWED_CIDR_BLOCKS` tight.
- **Speech endpoint.** The Lambda Function URL is public but rejects requests without its generated bearer token.

## Speech (Lambda) image

The Lambda image is tagged `asr-<hash>`, a hash of `deploy/asr-lambda/`, `src/asr/indic_asr.py` and `.dockerignore`. It is rebuilt and rolled out only when one of those files changes. UI and server-only changes skip the roughly 7 GB build.

The EC2 root disk and app configuration use dedicated encrypted storage keys. Doctor-approved examples and generated `output/` reports persist on that instance, but are not backed up by this stack. Terraform state contains the generated Lambda token and must remain private. Lambda builds use the repository's `deploy/asr-lambda/Dockerfile` for `linux/amd64` and can take several minutes because the speech models are included in the image.