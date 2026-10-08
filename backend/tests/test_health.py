from __future__ import annotations

import re

import httpx


async def test_liveness(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_readiness_ok_on_migrated_database(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    components = body["components"]
    assert components["database"]["status"] == "ok"
    assert components["database"]["data"]["dialect"] == "sqlite"
    assert components["migrations"]["status"] == "ok"
    assert components["migrations"]["data"]["current"] == components["migrations"]["data"]["head"]


async def test_integrations_report_their_real_state_never_ok_by_default(
    client: httpx.AsyncClient,
) -> None:
    components = (await client.get("/api/health/ready")).json()["components"]
    assert components["ai_provider"]["status"] == "not_configured"
    assert components["ai_provider"]["critical"] is False
    assert components["ai_provider"]["data"]["key_present"] is False
    assert components["email"]["status"] == "not_configured"


async def test_readiness_reports_pending_migrations(db_url, make_settings, make_client) -> None:
    async with make_client(make_settings(NEXUS_DATABASE_URL=db_url)) as http:
        response = await http.get("/api/health/ready")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["components"]["database"]["status"] == "ok"
    assert body["components"]["migrations"]["status"] == "migrations_pending"
    assert body["components"]["migrations"]["data"]["current"] is None


async def test_readiness_reports_unreachable_database(make_settings, make_client) -> None:
    # Port 1 on localhost refuses connections immediately.
    settings = make_settings(NEXUS_DATABASE_URL="postgresql+asyncpg://nexus@127.0.0.1:1/nexus")
    async with make_client(settings) as http:
        response = await http.get("/api/health/ready")
    assert response.status_code == 503
    body = response.json()
    assert body["components"]["database"]["status"] == "error"
    assert body["components"]["database"]["data"]["dialect"] == "postgresql"
    assert body["components"]["migrations"]["status"] == "error"


async def test_system_info_never_exposes_secret_values(
    migrated_db_url, make_settings, make_client
) -> None:
    fake_key = "nvapi-" + "T" * 40
    fake_master = "M" * 44
    settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url, NVIDIA_API_KEY=fake_key, NEXUS_SECRET_KEY=fake_master
    )
    async with make_client(settings) as http:
        info = await http.get("/api/system/info")
        ready = await http.get("/api/health/ready")
    assert info.status_code == 200
    body = info.json()
    assert body["name"] == "NEXUS AI"
    assert body["nvidia_key_present"] is True
    assert re.fullmatch(r"[0-9a-f]{32}", body["installation_id"])
    for response in (info, ready):
        assert fake_key not in response.text
        assert fake_master not in response.text


async def test_system_info_without_migrations_has_no_installation_id(
    db_url, make_settings, make_client
) -> None:
    async with make_client(make_settings(NEXUS_DATABASE_URL=db_url)) as http:
        response = await http.get("/api/system/info")
    assert response.status_code == 200
    assert response.json()["installation_id"] is None


async def test_request_id_is_generated_echoed_and_sanitised(client: httpx.AsyncClient) -> None:
    generated = await client.get("/api/health/live")
    assert re.fullmatch(r"[0-9a-f]{32}", generated.headers["x-request-id"])

    echoed = await client.get("/api/health/live", headers={"X-Request-ID": "trace-abc.123"})
    assert echoed.headers["x-request-id"] == "trace-abc.123"

    hostile = await client.get("/api/health/live", headers={"X-Request-ID": "x" * 500})
    assert hostile.headers["x-request-id"] != "x" * 500


async def test_cors_allows_only_configured_origins(client: httpx.AsyncClient) -> None:
    allowed = await client.get("/api/health/live", headers={"Origin": "http://localhost:3000"})
    assert allowed.headers.get("access-control-allow-origin") == "http://localhost:3000"

    denied = await client.get("/api/health/live", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in denied.headers
