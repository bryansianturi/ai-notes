resource "docker_network" "app" {
  name = "tf-ai-notes"
}

resource "docker_volume" "pgdata" {
  name = "tf-ai-notes-pgdata"
}

resource "docker_image" "postgres" {
  name         = "postgres:17"
  keep_locally = true
}

resource "docker_container" "db" {
  name  = "tf-db"
  image = docker_image.postgres.image_id

  env = [
    "POSTGRES_USER=student",
    "POSTGRES_PASSWORD=${var.db_password}",
    "POSTGRES_DB=ainotes",
  ]

  networks_advanced {
    name    = docker_network.app.name
    aliases = ["db"]
  }

  ports {
    internal = 5432
    external = var.db_port
    ip       = "127.0.0.1" # loopback only (Lab 1's lesson)
  }

  volumes {
    volume_name    = docker_volume.pgdata.name
    container_path = "/var/lib/postgresql/data"
  }

  healthcheck {
    test     = ["CMD-SHELL", "pg_isready -U student -d ainotes"]
    interval = "2s"
    timeout  = "3s"
    retries  = 15
  }
  wait = true # don't finish until the healthcheck passes
}

resource "docker_image" "app" {
  name         = var.app_image
  keep_locally = true
}

resource "docker_container" "web" {
  name    = "tf-web"
  image   = docker_image.app.image_id
  restart = "on-failure"

  env = [
    "DATABASE_URL=postgresql://student:${var.db_password}@db:5432/ainotes",
    "OLLAMA_URL=http://host.docker.internal:11434",
  ]

  networks_advanced {
    name = docker_network.app.name
  }

  ports {
    internal = 8000
    external = var.web_port
    ip       = "127.0.0.1"
  }

  depends_on = [docker_container.db]
}
