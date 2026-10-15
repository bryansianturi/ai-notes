resource "kubernetes_namespace_v1" "env" {
  for_each = var.environments

  metadata {
    name = "tf-${each.key}"
    labels = {
      "managed-by"  = "terraform"
      "environment" = each.key
    }
  }
}

resource "kubernetes_config_map_v1" "app_config" {
  for_each = var.environments

  metadata {
    name      = "app-config"
    namespace = kubernetes_namespace_v1.env[each.key].metadata[0].name
  }

  data = {
    ENVIRONMENT = each.key
    MODEL       = var.model
    LOG_LEVEL   = each.key == "dev" ? "debug" : "info"
  }
}
