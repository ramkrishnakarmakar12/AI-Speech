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
  description = "Hostname for HTTPS, e.g. rx-lef.paninieight.com. Empty = <server-ip>.sslip.io (dedicated server only)."
}

variable "existing_instance_id" {
  type        = string
  default     = ""
  description = "Run the app on this existing EC2 (behind its nginx) instead of creating a server. Empty = create a dedicated EC2."
}

variable "route53_zone_name" {
  type        = string
  default     = ""
  description = "Public Route 53 hosted zone that contains var.domain (e.g. paninieight.com). Set it to have Terraform create the A record."
}

variable "asr_decoding" {
  type        = string
  default     = "rnnt"
  description = "IndicConformer decoder on Lambda: rnnt (more accurate, slow on CPU) or ctc (several times faster, slightly less accurate)."

  validation {
    condition     = contains(["rnnt", "ctc"], var.asr_decoding)
    error_message = "asr_decoding must be rnnt or ctc."
  }
}
