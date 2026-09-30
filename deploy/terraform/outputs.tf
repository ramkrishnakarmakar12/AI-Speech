output "instance_id" {
  value = aws_instance.app.id
}

output "app_url" {
  value = "http://${aws_instance.app.public_ip}"
}

output "app_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "asr_repository_url" {
  value = aws_ecr_repository.asr.repository_url
}

output "asr_function_url" {
  value = aws_lambda_function_url.asr.function_url
}

output "app_env_parameter_name" {
  value = aws_ssm_parameter.app_env.name
}
