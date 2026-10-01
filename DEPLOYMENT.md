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

## Using your own domain (prod)

1. Push to `main` once **without** `DOMAIN`. This creates the Elastic IP, shown as `public_ip` in the Terraform output and in the deploy log. The site comes up on `https://<ip>.sslip.io`.
2. At your domain registrar or DNS provider, add an **A record** pointing your hostname (for example `rx.yourclinic.in`) at that IP. Remove any AAAA record for it.
3. In GitHub, go to Settings, then Environments, then `prod`, then Variables, and set `DOMAIN=rx.yourclinic.in`. Re-run the workflow, or push again.

The Elastic IP never changes, so this is a one-time step. If `DOMAIN` is set but its DNS doesn't point at the Elastic IP yet, the workflow stops before deploying and shows the record to create. Caddy renews the certificate automatically.

You can also set the A record and `DOMAIN` before the first deploy. That run then stops at the DNS check and prints the new IP. Create the record and re-run.

## How the site is served

- **Elastic IP.** The server keeps a fixed public address, even across stop/start or replacement. Terraform outputs it as `public_ip`.
- **HTTPS.** Caddy runs in front of the app (`deploy/app/remote-deploy.sh`) and gets a free Let's Encrypt certificate. Browsers only allow the microphone on HTTPS pages, so **live recording works only through this HTTPS address**. Without `DOMAIN`, the hostname is `<elastic-ip-with-dashes>.sslip.io`, which needs no DNS setup. The deploy summary shows the exact URL (`app_url`).
- **Access.** Port 443 is open only to `ALLOWED_CIDR_BLOCKS`. Port 80 is open to everyone because Let's Encrypt must reach it to issue the certificate. On port 80, Caddy answers only that challenge and redirects everything else to HTTPS. The app container itself is not exposed; it sits on a private Docker network behind Caddy.
- **No login.** The web app has no login/authentication, so IP filtering is its only access control. Keep `ALLOWED_CIDR_BLOCKS` tight.
- **Speech endpoint.** The Lambda Function URL is public but rejects requests without its generated bearer token.

## Speech (Lambda) image

The Lambda image is tagged `asr-<hash>`, a hash of `deploy/asr-lambda/`, `src/asr/indic_asr.py` and `.dockerignore`. It is rebuilt and rolled out only when one of those files changes. UI and server-only changes skip the roughly 7 GB build.

The EC2 root disk and app configuration use dedicated encrypted storage keys. Doctor-approved examples and generated `output/` reports persist on that instance, but are not backed up by this stack. Terraform state contains the generated Lambda token and must remain private. Lambda builds use the repository's `deploy/asr-lambda/Dockerfile` for `linux/amd64` and can take several minutes because the speech models are included in the image.