import uuid

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


def test_summarise_returns_502_when_ollama_errors(client, monkeypatch):
    def model_not_found(*a, **kw):
        response = requests.Response()
        response.status_code = 404
        raise requests.HTTPError(response=response)

    monkeypatch.setattr(main.requests, "post", model_not_found)

    note_id = client.post("/notes", json={"title": "T", "body": "A long note"}).json()[
        "id"
    ]
    r = client.post(f"/notes/{note_id}/summarise")

    assert r.status_code == 502


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_metrics_endpoint(client):
    client.get("/health")
    r = client.get("/metrics")
    assert r.status_code == 200
    assert "http_requests_total" in r.text


def test_request_id_is_returned(client):
    r = client.get("/health", headers={"X-Request-ID": "abc123"})
    assert r.headers["X-Request-ID"] == "abc123"


# --- Helpers for the tests below ---------------------------------------------


def make_note(client, title="T", body="A long note"):
    r = client.post("/notes", json={"title": title, "body": body})
    assert r.status_code == 201
    return r.json()


def fake_ollama(monkeypatch, reply):
    class Fake:
        def raise_for_status(self):
            pass

        def json(self):
            return reply

    monkeypatch.setattr(main.requests, "post", lambda *a, **kw: Fake())


# --- Validation ---------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "", "body": "x"},
        {"title": "x", "body": ""},
        {"title": "x" * (main.TITLE_MAX + 1), "body": "x"},
        {"title": "x", "body": "x" * (main.BODY_MAX + 1)},
        {"title": "x"},
    ],
)
def test_create_note_rejects_bad_input(client, payload):
    assert client.post("/notes", json=payload).status_code == 422


# --- CRUD ---------------------------------------------------------------------


def test_get_note(client):
    note = make_note(client, title="Get me")
    r = client.get(f"/notes/{note['id']}")
    assert r.status_code == 200
    assert r.json()["title"] == "Get me"
    assert r.json()["summary"] is None
    assert r.json()["summary_stale"] is False


def test_get_missing_note_returns_404(client):
    assert client.get("/notes/999999").status_code == 404


def test_update_note(client):
    note = make_note(client, title="Old", body="Old body")
    r = client.patch(f"/notes/{note['id']}", json={"title": "New"})
    assert r.status_code == 200
    assert r.json()["title"] == "New"
    assert r.json()["body"] == "Old body"


def test_update_rejects_empty_title(client):
    note = make_note(client)
    assert client.patch(f"/notes/{note['id']}", json={"title": ""}).status_code == 422


def test_update_missing_note_returns_404(client):
    assert client.patch("/notes/999999", json={"title": "x"}).status_code == 404


def test_delete_note(client):
    note = make_note(client)
    assert client.delete(f"/notes/{note['id']}").status_code == 204
    assert client.get(f"/notes/{note['id']}").status_code == 404
    assert client.delete(f"/notes/{note['id']}").status_code == 404


# --- Listing ------------------------------------------------------------------


def test_list_is_newest_first_and_paginated(client):
    tag = uuid.uuid4().hex
    ids = [make_note(client, title=f"{tag} {i}")["id"] for i in range(3)]

    r = client.get("/notes", params={"q": tag, "limit": 2})
    assert r.status_code == 200
    assert [n["id"] for n in r.json()] == [ids[2], ids[1]]
    assert r.headers["X-Total-Count"] == "3"

    r = client.get("/notes", params={"q": tag, "limit": 2, "offset": 2})
    assert [n["id"] for n in r.json()] == [ids[0]]


def test_search_matches_body_and_escapes_wildcards(client):
    tag = uuid.uuid4().hex
    match = make_note(client, body=f"{tag} costs 50% more")["id"]
    make_note(client, body=f"{tag} costs 500 more")

    r = client.get("/notes", params={"q": f"{tag} costs 50%"})
    assert [n["id"] for n in r.json()] == [match]


def test_list_rejects_bad_limit(client):
    assert client.get("/notes", params={"limit": 0}).status_code == 422
    assert client.get("/notes", params={"limit": 1000}).status_code == 422


# --- Summaries ----------------------------------------------------------------


def test_summary_is_saved_and_returned(client, monkeypatch):
    fake_ollama(monkeypatch, {"message": {"content": "  Saved summary.  "}})
    note = make_note(client)

    r = client.post(f"/notes/{note['id']}/summarise")
    assert r.status_code == 200
    assert r.json()["summary"] == "Saved summary."

    saved = client.get(f"/notes/{note['id']}").json()
    assert saved["summary"] == "Saved summary."
    assert saved["summary_model"] == main.MODEL
    assert saved["summary_prompt_version"] == main.PROMPT_VERSION
    assert saved["summary_stale"] is False


def test_editing_body_makes_summary_stale(client, monkeypatch):
    fake_ollama(monkeypatch, {"message": {"content": "A summary."}})
    note = make_note(client, body="First body")
    client.post(f"/notes/{note['id']}/summarise")

    # A title-only edit doesn't change what was summarised
    r = client.patch(f"/notes/{note['id']}", json={"title": "Renamed"})
    assert r.json()["summary_stale"] is False

    # Saving the same body again doesn't either
    r = client.patch(f"/notes/{note['id']}", json={"body": "First body"})
    assert r.json()["summary_stale"] is False

    r = client.patch(f"/notes/{note['id']}", json={"body": "Second body"})
    assert r.json()["summary_stale"] is True

    r = client.post(f"/notes/{note['id']}/summarise")
    assert r.json()["summary_stale"] is False


def test_changing_model_makes_summary_stale(client, monkeypatch):
    fake_ollama(monkeypatch, {"message": {"content": "A summary."}})
    note = make_note(client)
    client.post(f"/notes/{note['id']}/summarise")

    monkeypatch.setattr(main, "MODEL", "some-other-model")
    assert client.get(f"/notes/{note['id']}").json()["summary_stale"] is True


@pytest.mark.parametrize(
    "reply",
    [{}, {"message": {}}, {"message": {"content": "   "}}, {"message": "oops"}],
)
def test_summarise_returns_502_on_malformed_reply(client, monkeypatch, reply):
    fake_ollama(monkeypatch, reply)
    note = make_note(client)
    r = client.post(f"/notes/{note['id']}/summarise")
    assert r.status_code == 502
    assert client.get(f"/notes/{note['id']}").json()["summary"] is None


def test_summarise_returns_409_if_note_edited_meanwhile(client, monkeypatch):
    note = make_note(client, body="Original")

    def edit_while_summarising(*a, **kw):
        with main.get_conn() as conn:
            conn.execute(
                "UPDATE notes SET body = 'Edited' WHERE id = %s", (note["id"],)
            )
        return FakeOllamaResponse()

    monkeypatch.setattr(main.requests, "post", edit_while_summarising)
    r = client.post(f"/notes/{note['id']}/summarise")
    assert r.status_code == 409
    assert client.get(f"/notes/{note['id']}").json()["summary"] is None


# --- Health -------------------------------------------------------------------


def test_ready(client):
    r = client.get("/ready")
    assert r.status_code == 200
    assert r.json() == {"status": "ready"}


def test_unhandled_error_is_counted_as_500(monkeypatch):
    # Its own client, so the server error comes back as a 500 instead of raising
    def boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(main, "fetch_note", boom)
    before = main.REQUESTS.labels("GET", "/notes/{note_id}", 500)._value.get()

    with TestClient(main.app, raise_server_exceptions=False) as c:
        assert c.get("/notes/1").status_code == 500

    after = main.REQUESTS.labels("GET", "/notes/{note_id}", 500)._value.get()
    assert after == before + 1
