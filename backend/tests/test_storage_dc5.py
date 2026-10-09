from __future__ import annotations

import io
import zipfile

import httpx


async def upload(
    client: httpx.AsyncClient,
    name: str,
    content: bytes,
    *,
    parent_id: str | None = None,
    mime: str = "text/plain",
) -> dict[str, object]:
    data = {"parent_id": parent_id} if parent_id else None
    response = await client.post(
        "/api/storage/workspaces/ws_department:engineering/files",
        data=data,
        files={"file": (name, content, mime)},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_metadata_tags_search_and_safe_previews(client: httpx.AsyncClient) -> None:
    text = await upload(client, "Readme.html", b"<script>alert('never')</script>\nHello")
    image = await upload(client, "diagram.png", b"not-a-real-image", mime="image/png")
    office = await upload(
        client,
        "proposal.docx",
        b"office metadata only",
        mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

    changed = await client.patch(
        f"/api/storage/entries/{text['id']}",
        json={
            "description": "Browser preview fixture",
            "artifact_type": "documentation",
            "tags": ["Favorite", "Release", "release"],
        },
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["tags"] == ["Favorite", "Release"]
    assert changed.json()["favorite"] is True

    detail = (await client.get(f"/api/storage/entries/{text['id']}")).json()
    assert detail["preview_kind"] == "text"
    assert detail["artifact_type"] == "documentation"
    assert detail["owner_name"] == "Software Engineering"
    assert detail["versions"][0]["sha256"] == text["sha256"]
    assert any(event["kind"] == "entry_updated" for event in detail["events"])

    preview = await client.get(f"/api/storage/entries/{text['id']}/preview")
    assert preview.status_code == 200
    assert preview.headers["content-type"].startswith("text/plain")
    assert "sandbox" in preview.headers["content-security-policy"]
    assert preview.text.startswith("<script>")  # displayed as text, never HTML
    image_preview = await client.get(f"/api/storage/entries/{image['id']}/preview")
    assert image_preview.status_code == 200
    assert image_preview.headers["content-type"] == "image/png"
    assert image_preview.content == b"not-a-real-image"
    unsupported = await client.get(f"/api/storage/entries/{office['id']}/preview")
    assert unsupported.status_code == 415

    by_description = await client.get(
        "/api/storage/search",
        params={"workspace_id": "ws_department:engineering", "q": "browser preview"},
    )
    assert [item["id"] for item in by_description.json()["items"]] == [text["id"]]
    favorites = await client.get(
        "/api/storage/search",
        params={"workspace_id": "ws_department:engineering", "tag": "favorite"},
    )
    assert [item["id"] for item in favorites.json()["items"]] == [text["id"]]
    page = await client.get(
        "/api/storage/search",
        params={
            "workspace_id": "ws_department:engineering",
            "kind": "file",
            "sort": "name",
            "order": "asc",
            "limit": 2,
        },
    )
    assert page.json()["total"] == 3
    assert len(page.json()["items"]) == 2


async def test_folder_copy_zip_export_and_permanent_delete(client: httpx.AsyncClient) -> None:
    folder_response = await client.post(
        "/api/storage/workspaces/ws_department:engineering/folders",
        json={"name": "Release"},
    )
    assert folder_response.status_code == 201
    folder = folder_response.json()
    source = await upload(client, "notes.txt", b"release notes", parent_id=folder["id"])

    copied_response = await client.post(f"/api/storage/entries/{folder['id']}/duplicate", json={})
    assert copied_response.status_code == 201, copied_response.text
    copied = copied_response.json()
    assert copied["name"] == "Release copy"
    copied_children = (
        await client.get(
            "/api/storage/workspaces/ws_department:engineering/entries",
            params={"parent_id": copied["id"]},
        )
    ).json()
    assert len(copied_children) == 1
    copied_file = copied_children[0]
    downloaded = await client.get(f"/api/storage/entries/{copied_file['id']}/download")
    assert downloaded.content == b"release notes"
    assert copied_file["sha256"] == source["sha256"]

    exported = await client.post("/api/storage/export", json={"entry_ids": [folder["id"]]})
    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert "engineering/Release/" in archive.namelist()
        assert archive.read("engineering/Release/notes.txt") == b"release notes"

    not_trashed = await client.delete(
        f"/api/storage/entries/{copied['id']}/permanent", params={"confirm": "true"}
    )
    assert not_trashed.status_code == 409
    assert (await client.delete(f"/api/storage/entries/{copied['id']}")).status_code == 200
    confirmation_required = await client.delete(f"/api/storage/entries/{copied['id']}/permanent")
    assert confirmation_required.status_code == 422
    deleted = await client.delete(
        f"/api/storage/entries/{copied['id']}/permanent", params={"confirm": "true"}
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"items": 2, "versions": 1, "blobs_removed": 1}
    assert (await client.get(f"/api/storage/entries/{copied_file['id']}")).status_code == 404


async def test_large_text_preview_is_bounded(client: httpx.AsyncClient) -> None:
    entry = await upload(client, "large.txt", b"x" * (300 * 1024))
    preview = await client.get(f"/api/storage/entries/{entry['id']}/preview")
    assert preview.status_code == 200
    assert preview.headers["x-preview-truncated"] == "true"
    assert len(preview.content) == 256 * 1024
