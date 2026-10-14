import hashlib
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path

import psycopg
import requests
from fastapi import FastAPI, HTTPException, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from psycopg.rows import dict_row
from pydantic import BaseModel

# Settings come from environment variables, with defaults for running on your Mac.
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://student:devpassword@localhost:5433/ainotes"
)
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
MODEL = os.getenv("MODEL", "qwen3.5:4b")
PROMPT_PATH = Path(__file__).parent / "prompts" / "summarise.txt"
SYSTEM_PROMPT = PROMPT_PATH.read_text().strip()
PROMPT_VERSION = hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:8]
REQUESTS = Counter(
    "http_requests_total", "HTTP requests handled", ["method", "path", "status"]
)
LATENCY = Histogram(
    "http_request_duration_seconds", "Time to handle a request", ["method", "path"]
)
OLLAMA_LATENCY = Histogram(
    "ollama_summary_duration_seconds",
    "Time Ollama takes to summarise a note",
    ["model"],
    buckets=(0.5, 1, 2, 5, 10, 20, 30, 60, 120),
)
OLLAMA_TOKENS = Counter("ollama_tokens_total", "Tokens processed by Ollama", ["type"])
OLLAMA_ERRORS = Counter("ollama_errors_total", "Failed calls to Ollama")


def get_conn():
    # dict_row makes each row a dict like {"id": 1, "title": ...}
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def ask_ollama(text: str, model: str = MODEL) -> dict:
    """Send text to Ollama and return its raw JSON reply. Used by the API and by evals."""
    r = requests.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            "stream": False,
            "think": False,
        },
        timeout=120,
    )
    r.raise_for_status()
    return r.json()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Runs once when the app starts: make sure the table exists.
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT now()
            )
        """)
    yield


app = FastAPI(title="ai-notes", lifespan=lifespan)


@app.middleware("http")
async def track_requests(request: Request, call_next):
    # Reuse the caller's ID if they sent one, otherwise make a short new one
    request_id = request.headers.get("x-request-id", uuid.uuid4().hex[:8])
    request_id_var.set(request_id)

    start = time.perf_counter()
    response = await call_next(request)
    duration = time.perf_counter() - start

    route = request.scope.get("route")
    path = route.path if route else "unmatched"

    if path != "/metrics":
        REQUESTS.labels(request.method, path, response.status_code).inc()
        LATENCY.labels(request.method, path).observe(duration)
        log.info(
            "request",
            extra={
                "fields": {
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "duration_ms": round(duration * 1000, 1),
                }
            },
        )

    response.headers["X-Request-ID"] = request_id
    return response


@app.get("/metrics", include_in_schema=False)
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# Holds the current request's ID, so every log line can include it automatically
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


class JsonFormatter(logging.Formatter):
    def format(self, record):
        entry = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "message": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        entry.update(getattr(record, "fields", {}))
        return json.dumps(entry)


handler = logging.StreamHandler()
handler.setFormatter(JsonFormatter())
log = logging.getLogger("ai-notes")
log.addHandler(handler)
log.setLevel(logging.INFO)
log.propagate = False


class NoteIn(BaseModel):
    title: str
    body: str


@app.post("/notes", status_code=201)
def create_note(note: NoteIn):
    with get_conn() as conn:
        row = conn.execute(
            "INSERT INTO notes (title, body) VALUES (%s, %s) RETURNING id",
            (note.title, note.body),
        ).fetchone()
    return {"id": row["id"], **note.model_dump()}


@app.get("/notes")
def list_notes():
    with get_conn() as conn:
        return conn.execute(
            "SELECT id, title, body, created_at FROM notes ORDER BY id"
        ).fetchall()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/notes/{note_id}/summarise")
def summarise_note(note_id: int):
    with get_conn() as conn:
        note = conn.execute(
            "SELECT body FROM notes WHERE id = %s", (note_id,)
        ).fetchone()
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")

    start = time.perf_counter()
    try:
        data = ask_ollama(note["body"])
    except requests.RequestException as e:
        OLLAMA_ERRORS.inc()
        log.warning(
            "ollama_failed",
            extra={
                "fields": {
                    "note_id": note_id,
                    "error": type(e).__name__,
                    "detail": str(e)[:200],
                }
            },
        )
        raise HTTPException(
            status_code=503, detail="Can't reach Ollama. Is it running?"
        )
    finally:
        OLLAMA_LATENCY.labels(MODEL).observe(time.perf_counter() - start)

    OLLAMA_TOKENS.labels("prompt").inc(data.get("prompt_eval_count", 0))
    OLLAMA_TOKENS.labels("completion").inc(data.get("eval_count", 0))
    log.info(
        "summarised",
        extra={
            "fields": {
                "note_id": note_id,
                "model": MODEL,
                "prompt_version": PROMPT_VERSION,
                "duration_s": round(time.perf_counter() - start, 2),
                "prompt_tokens": data.get("prompt_eval_count", 0),
                "completion_tokens": data.get("eval_count", 0),
            }
        },
    )
    return {"id": note_id, "summary": data["message"]["content"]}
