provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

resource "aws_ecr_repository" "app" {
  name                 = "ai-speech-${var.environment}-app"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "asr" {
  name                 = "ai-speech-${var.environment}-asr"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain recent application images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "asr" {
  repository = aws_ecr_repository.asr.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain recent ASR images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_kms_key" "app_env" {
  description             = "Encrypt AI Speech ${var.environment} application configuration"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Environment = var.environment
  }
}

resource "aws_kms_alias" "app_env" {
  name          = "alias/ai-speech-${var.environment}-app-env"
  target_key_id = aws_kms_key.app_env.key_id
}

resource "random_password" "asr_token" {
  length  = 48
  special = false
}

resource "aws_iam_role" "lambda" {
  name = "ai-speech-${var.environment}-asr"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_ecr_repository_policy" "asr_lambda" {
  repository = aws_ecr_repository.asr.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LambdaECRImageRetrievalPolicy"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    }]
  })
}

resource "aws_lambda_function" "asr" {
  function_name = "ai-speech-${var.environment}-asr"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.asr.repository_url}:${var.lambda_image_tag}"
  architectures = ["x86_64"]
  memory_size   = 10240
  timeout       = 900

  ephemeral_storage {
    size = 2048
  }

  environment {
    variables = {
      ASR_TOKEN = random_password.asr_token.result
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    aws_ecr_repository_policy.asr_lambda
  ]
}

resource "aws_lambda_function_url" "asr" {
  function_name      = aws_lambda_function.asr.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.asr.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "url_invoke" {
  statement_id             = "AllowPublicFunctionUrlInvoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.asr.function_name
  principal                = "*"
  invoked_via_function_url = true
}

resource "aws_ssm_parameter" "app_env" {
  name   = "/ai-speech/${var.environment}/app-env"
  type   = "SecureString"
  key_id = aws_kms_key.app_env.arn
  value = templatefile("${path.module}/app.env.tftpl", {
    aws_region = var.aws_region
    asr_url    = aws_lambda_function_url.asr.function_url
    asr_token  = random_password.asr_token.result
    llm_model  = var.llm_model
  })

  tags = {
    Environment = var.environment
  }
}
