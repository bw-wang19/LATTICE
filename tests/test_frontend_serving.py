"""The optional frontend build shares the API origin without hiding API errors."""

from fastapi.testclient import TestClient

from lattice.api import create_app
from lattice.config import Settings


def test_frontend_build_and_api_share_origin(tmp_path):
    build = tmp_path / "frontend" / "dist"
    assets = build / "assets"
    assets.mkdir(parents=True)
    (build / "index.html").write_text("<html>LATTICE interface</html>")
    (build / "favicon.svg").write_text("<svg></svg>")
    (build / "404.html").write_text("<html>Static not found</html>")
    (assets / "app.js").write_text("console.log('LATTICE');")
    # Even a build asset in this namespace must not hide an API error.
    (build / "api").mkdir()
    (build / "api" / "missing").write_text("not an API response")
    settings = Settings.model_validate({"storage": {"database_path": tmp_path / "chat.db"}})

    with TestClient(create_app(settings=settings, frontend_dist=build)) as client:
        assert "LATTICE interface" in client.get("/").text
        assert "console.log" in client.get("/assets/app.js").text
        assert client.get("/favicon.svg").headers["content-type"].startswith("image/svg+xml")
        assert client.get("/healthz").json()["status"] == "ok"
        assert client.get("/docs").status_code == 200
        assert client.get("/openapi.json").json()["info"]["title"] == "LATTICE"
        assert client.get("/api/conversations").json() == []
        response = client.post("/api/chat", json={"question": "Explain SQLite backup."})
        assert response.status_code == 201
        assert "[MOCK]" in response.json()["answer"]
        for method in ("GET", "POST", "DELETE"):
            missing = client.request(method, "/api/missing")
            assert missing.status_code == 404
            assert missing.json() == {"detail": "Not Found"}
        assert client.get("/api").status_code == 404
        assert client.get("/api/conversations/missing/graph").json() == {
            "detail": "Conversation or turn not found."
        }

        # StaticFiles confines reads to the build directory.
        (tmp_path / "private.txt").write_text("private data")
        outside = client.get("/%2e%2e/%2e%2e/private.txt")
        assert outside.status_code == 404
        assert "private data" not in outside.text


def test_missing_or_incomplete_frontend_build_does_not_break_api(tmp_path):
    settings = Settings.model_validate({"storage": {"database_path": tmp_path / "chat.db"}})
    build = tmp_path / "not-built"
    for has_directory in (False, True):
        if has_directory:
            build.mkdir()
        with TestClient(create_app(settings=settings, frontend_dist=build)) as client:
            assert client.get("/").status_code == 404
            assert client.get("/healthz").json()["status"] == "ok"
            assert client.get("/api/conversations").json() == []
            assert client.get("/api/missing").json() == {"detail": "Not Found"}
