variable "app_image" {
  type        = string
  description = "Image to run, e.g. ghcr.io/you/ai-notes:<sha>"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "db_port" {
  type    = number
  default = 5434
}

variable "web_port" {
  type    = number
  default = 8002
}
