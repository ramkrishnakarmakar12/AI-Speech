# CI/CD deployment

GitHub Actions runs type checking and tests before deploying. Only pushes to `main` deploy, using the GitHub `prod` environment and production AWS resources. The `dev` environment is dormant for now; pushes to `develop` do not run this workflow. The Node app runs in Docker on EC2; the speech endpoint is deployed as a Lambda container image.

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

4. Add `HF_TOKEN` as a secret in `prod`. The account behind this token must have accepted the Hugging Face terms for `ai4bharat/indic-conformer-600m-multilingual`; the image build downloads gated model weights.
5. Ensure Bedrock model access is enabled in the selected region. The EC2 instance role receives Bedrock invoke permissions; the application config and generated ASR bearer token are stored in SSM Parameter Store as a `SecureString` encrypted with a dedicated KMS key.
6. Push to `main`. The initial run creates ECR repositories before building and pushing images; Terraform then provisions the rest of the infrastructure and the app is rolled out through Systems Manager.

`ALLOWED_CIDR_BLOCKS` is required and controls HTTP access to port 80. This stack does not configure a domain name or HTTPS, and the web app has no login/authentication; CIDR filtering is its only access control. Do not use real patient data until application authentication/authorization and TLS are in place. The Lambda Function URL is public but rejects requests without its generated bearer token.

The EC2 root disk and app configuration use dedicated encrypted storage keys. Doctor-approved examples and generated `output/` reports persist on that instance, but are not backed up by this stack. Terraform state contains the generated Lambda token and must remain private. Lambda builds use the repository's `deploy/asr-lambda/Dockerfile` for `linux/amd64` and can take several minutes because the speech models are included in the image.