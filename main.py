import os
from contextlib import asynccontextmanager

import psycopg
import requests
from fastapi import FastAPI, HTTPException
from psycopg.rows import dict_row
from pydantic import BaseModel

# Settings come from environment variables, with defaults for running on your Mac.
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://student:devpassword@localhost:5433/ainotes"
)
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
MODEL = os.getenv("MODEL", "qwen3.5:4b")


def get_conn():
    # dict_row makes each row a dict like {"id": 1, "title": ...}
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


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


@app.post("/notes/{note_id}/summarise")
def summarise_note(note_id: int):
    with get_conn() as conn:
        note = conn.execute(
            "SELECT body FROM notes WHERE id = %s", (note_id,)
        ).fetchone()
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")

    try:
        r = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": MODEL,
                "messages": [
                    {
                        "role": "system",
                        "content": "Summarise the user's note in one short sentence.",
                    },
                    {"role": "user", "content": note["body"]},
                ],
                "stream": False,
                "think": False,
            },
            timeout=120,
        )
        r.raise_for_status()
    except requests.RequestException:
        raise HTTPException(
            status_code=503, detail="Can't reach Ollama. Is it running?"
        )

    return {"id": note_id, "summary": r.json()["message"]["content"]}
