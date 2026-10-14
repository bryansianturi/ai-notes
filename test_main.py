import pytest
import requests
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client():
    # "with" runs the app's startup code (creating the table), like uvicorn does
    with TestClient(main.app) as c:
        yield c


def test_create_and_list_note(client):
    r = client.post("/notes", json={"title": "Test", "body": "Hello world"})
    assert r.status_code == 201
    note_id = r.json()["id"]

    r = client.get("/notes")
    assert r.status_code == 200
    assert any(n["id"] == note_id for n in r.json())


def test_summarise_missing_note_returns_404(client):
    r = client.post("/notes/999999/summarise")
    assert r.status_code == 404


class FakeOllamaResponse:
    def raise_for_status(self):
        pass

    def json(self):
        return {"message": {"content": "A fake summary."}}


def test_summarise_uses_ollama(client, monkeypatch):
    # Replace the real requests.post with a fake: no Ollama needed
    monkeypatch.setattr(main.requests, "post", lambda *a, **kw: FakeOllamaResponse())

    note_id = client.post("/notes", json={"title": "T", "body": "A long note"}).json()[
        "id"
    ]
    r = client.post(f"/notes/{note_id}/summarise")

    assert r.status_code == 200
    assert r.json()["summary"] == "A fake summary."


def test_summarise_returns_503_when_ollama_down(client, monkeypatch):
    def ollama_is_down(*a, **kw):
        raise requests.ConnectionError()

    monkeypatch.setattr(main.requests, "post", ollama_is_down)

    note_id = client.post("/notes", json={"title": "T", "body": "A long note"}).json()[
        "id"
    ]
    r = client.post(f"/notes/{note_id}/summarise")

    assert r.status_code == 503


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
