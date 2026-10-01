variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "allowed_cidr_blocks" {
  type        = list(string)
  description = "IPv4 ranges allowed to open the app over HTTPS; use clinic/VPN IPs where possible."

  validation {
    condition     = length(var.allowed_cidr_blocks) > 0 && alltrue([for cidr in var.allowed_cidr_blocks : can(cidrnetmask(cidr))])
    error_message = "Set at least one valid IPv4 CIDR in ALLOWED_CIDR_BLOCKS."
  }
}

variable "instance_type" {
  type    = string
  default = "t3.small"
}

variable "llm_model" {
  type        = string
  description = "Bedrock model or inference profile ID available in aws_region."

  validation {
    condition     = length(trimspace(var.llm_model)) > 0
    error_message = "llm_model must be set to a Bedrock model or inference profile ID."
  }
}

variable "lambda_image_tag" {
  type = string
}

variable "domain" {
  type        = string
  default     = ""
  description = "Hostname for HTTPS (an A record pointing at the Elastic IP). Empty = <elastic-ip>.sslip.io."
}
