# Where the web app runs. Two modes, chosen by var.existing_instance_id:
#
#   existing_instance_id = "i-..."  (current prod: the LEF server)
#     The app runs as one more container on that server, behind its own nginx, on var.domain
#     (rx-lef.paninieight.com). Terraform does NOT create or change the server, its security group
#     or its IP. It only adds an AI Speech policy to the server's IAM role (or attaches a new role if
#     the server has none) so it can pull the image, read its settings and call Bedrock.
#
#   existing_instance_id = ""       (dedicated server)
#     Terraform creates an EC2, an Elastic IP and a security group; Caddy serves HTTPS.

locals {
  use_existing = trimspace(var.existing_instance_id) != ""
  name         = "ai-speech-${var.environment}"
}

# ======================= existing server (LEF) =======================
data "aws_instance" "existing" {
  count       = local.use_existing ? 1 : 0
  instance_id = trimspace(var.existing_instance_id)
}

locals {
  existing_profile = local.use_existing ? data.aws_instance.existing[0].iam_instance_profile : ""
  # The server has no role (or only the one this stack attached earlier) -> this stack provides the role.
  own_role = !local.use_existing || local.existing_profile == "" || local.existing_profile == "${local.name}-ec2"
}

data "aws_iam_instance_profile" "existing" {
  count = local.own_role ? 0 : 1
  name  = local.existing_profile
}

locals {
  runtime_role_name = local.own_role ? aws_iam_role.ec2[0].name : data.aws_iam_instance_profile.existing[0].role_name

  instance_id = local.use_existing ? data.aws_instance.existing[0].id : aws_instance.app[0].id
  public_ip   = local.use_existing ? data.aws_instance.existing[0].public_ip : aws_eip.app[0].public_ip

  # Browsers only allow the microphone on HTTPS. Without a domain, <ip-with-dashes>.sslip.io
  # resolves to the server so a free certificate can still be issued (dedicated mode only).
  site_domain = trimspace(var.domain) != "" ? trimspace(var.domain) : "${replace(local.public_ip, ".", "-")}.sslip.io"
  proxy       = local.use_existing ? "nginx" : "caddy"
}

# ======================= IAM for the app on the server =======================
# Our own role: always in dedicated mode; on an existing server only when it has no role yet.
resource "aws_iam_role" "ec2" {
  count = local.own_role ? 1 : 0
  name  = "${local.name}-ec2"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  count      = local.own_role ? 1 : 0
  role       = aws_iam_role.ec2[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2" {
  count = local.own_role ? 1 : 0
  name  = "${local.name}-ec2"
  role  = aws_iam_role.ec2[0].name
}

# The existing server had no role: attach ours (there is no Terraform resource for an unmanaged instance)
resource "terraform_data" "attach_profile" {
  count            = local.use_existing && local.existing_profile == "" ? 1 : 0
  triggers_replace = [local.instance_id, aws_iam_instance_profile.ec2[0].name]

  provisioner "local-exec" {
    command = "sleep 15 && aws ec2 associate-iam-instance-profile --region ${var.aws_region} --instance-id ${local.instance_id} --iam-instance-profile Name=${aws_iam_instance_profile.ec2[0].name}"
  }
}

# Added to whichever role the server uses (our own, or LEF's existing role). Inline, so removing it
# later never touches LEF's own policies.
resource "aws_iam_role_policy" "ec2_runtime" {
  name = "${local.name}-runtime"
  role = local.runtime_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid      = "PullAppImage"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = [aws_ecr_repository.app.arn]
      },
      {
        Sid      = "ReadAppSettings"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/ai-speech/${var.environment}/app-env"
      },
      {
        Sid      = "DecryptAppSettings"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.app_env.arn
      },
      {
        Sid      = "Bedrock"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      },
      {
        # What the SSM agent needs so the deploy workflow can run commands on the server
        # (same core actions as AmazonSSMManagedInstanceCore; harmless if the role already has them)
        Sid    = "SsmAgent"
        Effect = "Allow"
        Action = [
          "ssm:UpdateInstanceInformation", "ssm:ListAssociations", "ssm:ListInstanceAssociations",
          "ssm:DescribeAssociation", "ssm:GetDocument", "ssm:DescribeDocument",
          "ssm:UpdateAssociationStatus", "ssm:UpdateInstanceAssociationStatus", "ssm:PutInventory",
          "ssm:PutComplianceItems", "ssm:PutConfigurePackageResult", "ssm:GetManifest",
          "ssm:GetDeployablePatchSnapshotForInstance",
          "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
          "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage",
          "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply",
        ]
        Resource = "*"
      },
    ]
  })
}

# ======================= dedicated server (only when existing_instance_id is empty) =======================
data "aws_vpc" "default" {
  count   = local.use_existing ? 0 : 1
  default = true
}

data "aws_subnets" "default" {
  count = local.use_existing ? 0 : 1

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_ami" "amazon_linux" {
  count       = local.use_existing ? 0 : 1
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "aws_security_group" "app" {
  count       = local.use_existing ? 0 : 1
  name        = "${local.name}-app"
  description = "Web application HTTPS access"
  vpc_id      = data.aws_vpc.default[0].id

  # Port 80 must be reachable by Let's Encrypt to issue the HTTPS certificate. Caddy answers only the
  # certificate challenge there and redirects everything else to HTTPS, which stays restricted below.
  ingress {
    description = "HTTP - Let's Encrypt challenge and redirect to HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "App HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "app" {
  count                       = local.use_existing ? 0 : 1
  ami                         = data.aws_ami.amazon_linux[0].id
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default[0].ids[0]
  vpc_security_group_ids      = [aws_security_group.app[0].id]
  iam_instance_profile        = aws_iam_instance_profile.ec2[0].name
  associate_public_ip_address = true

  user_data = <<-USERDATA
    #!/bin/bash
    set -euxo pipefail
    dnf install -y docker
    systemctl enable --now docker
    systemctl enable --now amazon-ssm-agent
    mkdir -p /opt/ai-speech/approved /opt/ai-speech/output
  USERDATA

  root_block_device {
    encrypted   = true
    volume_size = 30
    volume_type = "gp3"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # the app container needs IMDS for the instance role (Bedrock)
  }

  # A new AL2023 AMI is published every few weeks; without this every deploy after that would
  # replace the server and wipe the approved prescriptions stored on its disk.
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = {
    Name        = local.name
    Environment = var.environment
  }
}

# Fixed public address for the dedicated server
resource "aws_eip" "app" {
  count  = local.use_existing ? 0 : 1
  domain = "vpc"

  tags = {
    Name        = local.name
    Environment = var.environment
  }
}

resource "aws_eip_association" "app" {
  count         = local.use_existing ? 0 : 1
  instance_id   = aws_instance.app[0].id
  allocation_id = aws_eip.app[0].id
}

# ======================= DNS (Route 53) =======================
data "aws_route53_zone" "site" {
  count        = trimspace(var.route53_zone_name) != "" ? 1 : 0
  name         = trimspace(var.route53_zone_name)
  private_zone = false
}

resource "aws_route53_record" "site" {
  count   = trimspace(var.route53_zone_name) != "" ? 1 : 0
  zone_id = data.aws_route53_zone.site[0].zone_id
  name    = local.site_domain
  type    = "A"
  ttl     = 300
  records = [local.public_ip]

  lifecycle {
    precondition {
      condition     = trimspace(var.domain) != "" && endswith(trimspace(var.domain), trimsuffix(trimspace(var.route53_zone_name), "."))
      error_message = "Set DOMAIN (e.g. rx-lef.paninieight.com) to a name inside the Route 53 zone ROUTE53_ZONE."
    }
  }
}

data "aws_eips" "existing" {
  count = local.use_existing ? 1 : 0

  filter {
    name   = "instance-id"
    values = [local.instance_id]
  }
}

check "existing_server_settings" {
  assert {
    condition     = !local.use_existing || trimspace(var.domain) != ""
    error_message = "With EXISTING_INSTANCE_ID set, DOMAIN must be set too (e.g. rx-lef.paninieight.com)."
  }
  assert {
    condition     = !local.use_existing || data.aws_instance.existing[0].public_ip != ""
    error_message = "The existing instance has no public IP, so the subdomain cannot point at it."
  }
  assert {
    condition     = !local.use_existing || length(data.aws_eips.existing[0].public_ips) > 0
    error_message = "Warning: the existing instance has no Elastic IP. Its public IP changes if it is stopped/started, which breaks the DNS record (re-run the deploy to update it)."
  }
}
