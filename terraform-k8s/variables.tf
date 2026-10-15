variable "environments" {
  type    = set(string)
  default = ["dev", "staging"]
}

variable "model" {
  type    = string
  default = "qwen3.5:4b"
}
