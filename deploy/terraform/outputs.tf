output "instance_id" {
  value = local.instance_id
}

output "proxy" {
  description = "nginx = existing server's nginx in front of the app; caddy = dedicated server with Caddy"
  value       = local.proxy
}

output "runtime_role_name" {
  value = local.runtime_role_name
}

output "app_url" {
  value = "https://${local.site_domain}"
}

output "site_domain" {
  value = local.site_domain
}

output "public_ip" {
  value = local.public_ip
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
