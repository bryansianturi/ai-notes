# ai-notes

![CI](https://github.com/bryansianturi/ai-notes/actions/workflows/ci.yml/badge.svg)

A small FastAPI app that stores notes in Postgres and summarises them with a local LLM (Ollama)

## Running it

```sh
docker compose up --build      # API on :8000, web UI on http://localhost:8080
```

For front-end work with hot reload (proxies `/api` to the API on :8000):

```sh
cd frontend && npm install && npm run dev   # http://localhost:5173
```

The UI needs Ollama running on the host (`ollama serve`) and the model pulled (`ollama pull qwen3.5:4b`) to summarise notes.

## Deploying to Kubernetes

Argo CD syncs `k8s/` from `main` (see `argocd/app.yaml`). The database password is kept out of Git, so create its secret once per cluster, before or after the first sync:

```sh
PW=$(openssl rand -hex 24) && kubectl -n ai-notes create secret generic ai-notes-db \
  --from-literal=POSTGRES_PASSWORD="$PW" \
  --from-literal=DATABASE_URL="postgresql://student:${PW}@postgres:5432/ainotes"
```

Without it, `postgres` and `web` stay in `CreateContainerConfigError` with `secret "ai-notes-db" not found`. Postgres only reads the password when it initialises an empty volume, so if you replace the secret later on a volume that already has data, change the password inside Postgres to match.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/notes?limit=50&offset=0&q=` | Newest first. Total count in `X-Total-Count` |
| `POST` | `/notes` | `{"title", "body"}`. Title up to 200 chars, body up to 20,000 |
| `GET` / `PATCH` / `DELETE` | `/notes/{id}` | `PATCH` takes any of `title`, `body` |
| `POST` | `/notes/{id}/summarise` | Saves the summary on the note. `summary_stale` turns true when the body, model or prompt changes |
| `GET` | `/health` | Liveness: the process is up |
| `GET` | `/ready` | Readiness: the database answers |
| `GET` | `/metrics` | Prometheus |

## Tests

```sh
docker compose up -d db
pip install -r requirements-dev.txt && ruff check . && pytest
cd frontend && npm run lint && npm run typecheck && npm test
```
