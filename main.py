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
from fastapi import FastAPI, HTTPException, Query, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

# Settings come from environment variables, with defaults for running on your Mac.
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://student:devpassword@localhost:5433/ainotes"
)
DB_POOL_MAX = int(os.getenv("DB_POOL_MAX", "10"))
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
MODEL = os.getenv("MODEL", "qwen3.5:4b")
PROMPT_PATH = Path(__file__).parent / "prompts" / "summarise.txt"
SYSTEM_PROMPT = PROMPT_PATH.read_text().strip()
PROMPT_VERSION = hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:8]

TITLE_MAX = 200
BODY_MAX = 20_000

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

# Created when the app starts (see lifespan) and shared by every request
pool: ConnectionPool | None = None


def get_conn():
    """Borrow a connection from the pool. Use as `with get_conn() as conn:`.

    The block commits on success and rolls back on error, then the
    connection goes back to the pool instead of being closed.
    """
    if pool is None:
        raise RuntimeError("Database pool is not open (is the app started?)")
    return pool.connection()


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


SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS notes (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
    )
    """,
    # Columns added after the first release. ADD COLUMN IF NOT EXISTS makes
    # these safe to run on every start, against both new and old databases.
    "ALTER TABLE notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()",
    "ALTER TABLE notes ADD COLUMN IF NOT EXISTS body_updated_at TIMESTAMPTZ DEFAULT now()",
    "ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary TEXT",
    "ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_model TEXT",
    "ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_prompt_version TEXT",
    "ALTER TABLE notes ADD COLUMN IF NOT EXISTS summarised_at TIMESTAMPTZ",
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    new_pool = ConnectionPool(
        DATABASE_URL,
        min_size=1,
        max_size=DB_POOL_MAX,
        kwargs={"row_factory": dict_row},  # rows come back as dicts
        open=False,
    )
    new_pool.open(wait=True, timeout=30)
    pool = new_pool
    try:
        # Runs once when the app starts: make sure the schema is up to date.
        with new_pool.connection() as conn:
            # Several replicas can start at once; the lock stops them racing on the schema
            conn.execute("SELECT pg_advisory_xact_lock(1)")
            for statement in SCHEMA:
                conn.execute(statement)
        yield
    finally:
        new_pool.close()
        if pool is new_pool:
            pool = None


app = FastAPI(title="ai-notes", lifespan=lifespan)


def record_request(request: Request, status: int, duration: float) -> None:
    route = request.scope.get("route")
    path = route.path if route else "unmatched"
    if path == "/metrics":
        return
    REQUESTS.labels(request.method, path, status).inc()
    LATENCY.labels(request.method, path).observe(duration)
    log.info(
        "request",
        extra={
            "fields": {
                "method": request.method,
                "path": request.url.path,
                "status": status,
                "duration_ms": round(duration * 1000, 1),
            }
        },
    )


@app.middleware("http")
async def track_requests(request: Request, call_next):
    # Reuse the caller's ID if they sent one (capped, so logs stay sane), otherwise make one
    request_id = request.headers.get("x-request-id", "")[:64] or uuid.uuid4().hex[:8]
    request_id_var.set(request_id)

    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        # Unhandled errors become a 500 further up; count them here so they show in metrics
        record_request(request, 500, time.perf_counter() - start)
        log.exception("unhandled_error")
        raise

    record_request(request, response.status_code, time.perf_counter() - start)
    response.headers["X-Request-ID"] = request_id
    return response


@app.get("/metrics", include_in_schema=False)
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


class NoteIn(BaseModel):
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    body: str = Field(min_length=1, max_length=BODY_MAX)


class NotePatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=TITLE_MAX)
    body: str | None = Field(default=None, min_length=1, max_length=BODY_MAX)


NOTE_COLUMNS = """
    id, title, body, created_at, updated_at, body_updated_at,
    summary, summary_model, summary_prompt_version, summarised_at
"""


def to_note(row: dict) -> dict:
    """Shape a DB row for the API, adding whether its summary is out of date."""
    note = dict(row)
    body_updated_at = note.pop("body_updated_at")
    note["summary_stale"] = note["summary"] is not None and (
        note["summarised_at"] < body_updated_at
        or note["summary_model"] != MODEL
        or note["summary_prompt_version"] != PROMPT_VERSION
    )
    return note


def fetch_note(conn, note_id: int) -> dict:
    row = conn.execute(
        f"SELECT {NOTE_COLUMNS} FROM notes WHERE id = %s", (note_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return row


@app.post("/notes", status_code=201)
def create_note(note: NoteIn):
    with get_conn() as conn:
        row = conn.execute(
            f"INSERT INTO notes (title, body) VALUES (%s, %s) RETURNING {NOTE_COLUMNS}",
            (note.title, note.body),
        ).fetchone()
    return to_note(row)


@app.get("/notes")
def list_notes(
    response: Response,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    q: str | None = Query(None, max_length=200),
):
    where, params = "", []
    if q:
        # Escape LIKE wildcards so a search for "50%" means the literal text
        pattern = (
            "%" + q.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%"
        )
        where = "WHERE title ILIKE %s OR body ILIKE %s"
        params = [pattern, pattern]

    with get_conn() as conn:
        total = conn.execute(
            f"SELECT count(*) AS n FROM notes {where}", params
        ).fetchone()
        rows = conn.execute(
            f"SELECT {NOTE_COLUMNS} FROM notes {where} "
            "ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s",
            [*params, limit, offset],
        ).fetchall()

    response.headers["X-Total-Count"] = str(total["n"])
    return [to_note(r) for r in rows]


@app.get("/notes/{note_id}")
def get_note(note_id: int):
    with get_conn() as conn:
        return to_note(fetch_note(conn, note_id))


@app.patch("/notes/{note_id}")
def update_note(note_id: int, patch: NotePatch):
    changes = patch.model_dump(exclude_unset=True, exclude_none=True)
    with get_conn() as conn:
        if not changes:
            return to_note(fetch_note(conn, note_id))
        # Column names come from NotePatch's fields, never from user input
        sets = ", ".join(f"{col} = %({col})s" for col in changes)
        # In SET, "body" still means the old value, so this spots a real body change
        row = conn.execute(
            f"""
            UPDATE notes SET {sets}, updated_at = now(),
                body_updated_at = CASE
                    WHEN %(new_body)s::text IS NOT NULL
                         AND body IS DISTINCT FROM %(new_body)s::text THEN now()
                    ELSE body_updated_at
                END
            WHERE id = %(id)s
            RETURNING {NOTE_COLUMNS}
            """,
            {**changes, "id": note_id, "new_body": changes.get("body")},
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return to_note(row)


@app.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: int):
    with get_conn() as conn:
        deleted = conn.execute(
            "DELETE FROM notes WHERE id = %s RETURNING id", (note_id,)
        ).fetchone()
    if deleted is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return Response(status_code=204)


@app.get("/health")
def health():
    # Liveness: the process is up and serving. Deliberately doesn't touch the DB.
    return {"status": "ok"}


@app.get("/ready")
def ready():
    # Readiness: only take traffic when the database answers
    try:
        with pool.connection(timeout=2) as conn:
            conn.execute("SELECT 1")
    except psycopg.Error as e:
        log.warning("not_ready", extra={"fields": {"error": type(e).__name__}})
        raise HTTPException(status_code=503, detail="Database unavailable")
    return {"status": "ready"}


@app.post("/notes/{note_id}/summarise")
def summarise_note(note_id: int):
    with get_conn() as conn:
        note = fetch_note(conn, note_id)

    start = time.perf_counter()
    try:
        data = ask_ollama(note["body"])
    except requests.RequestException as e:
        OLLAMA_ERRORS.inc()
        status = e.response.status_code if e.response is not None else None
        log.warning(
            "ollama_failed",
            extra={
                "fields": {
                    "note_id": note_id,
                    "error": type(e).__name__,
                    "ollama_status": status,
                    "detail": str(e)[:200],
                }
            },
        )
        if status is not None:
            # Ollama is up but rejected the request, e.g. 404 when the model isn't pulled
            raise HTTPException(
                status_code=502, detail=f"Ollama returned an error ({status})"
            )
        raise HTTPException(
            status_code=503, detail="Can't reach Ollama. Is it running?"
        )
    finally:
        OLLAMA_LATENCY.labels(MODEL).observe(time.perf_counter() - start)

    message = data.get("message") if isinstance(data, dict) else None
    summary = message.get("content") if isinstance(message, dict) else None
    if not isinstance(summary, str) or not summary.strip():
        OLLAMA_ERRORS.inc()
        log.warning(
            "ollama_bad_reply",
            extra={"fields": {"note_id": note_id, "reply": str(data)[:200]}},
        )
        raise HTTPException(status_code=502, detail="Ollama returned an empty reply")
    summary = summary.strip()

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

    with get_conn() as conn:
        row = conn.execute(
            f"""
            UPDATE notes SET summary = %s, summary_model = %s,
                summary_prompt_version = %s, summarised_at = now()
            WHERE id = %s AND body = %s
            RETURNING {NOTE_COLUMNS}
            """,
            (summary, MODEL, PROMPT_VERSION, note_id, note["body"]),
        ).fetchone()
        if row is None:
            # The note was deleted or edited while Ollama was working
            fetch_note(conn, note_id)  # raises 404 if it's gone
            raise HTTPException(
                status_code=409, detail="Note changed while summarising; try again"
            )
    return to_note(row)
