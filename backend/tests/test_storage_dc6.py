from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.models import (
    App,
    AppFile,
    AppVersion,
    Attachment,
    CodeRun,
    Conversation,
    Employee,
    Message,
    StorageEntry,
    StorageEvent,
    StorageLink,
    StorageTag,
    StorageVersion,
    Task,
    Workflow,
)


async def test_real_sources_are_registered_with_bytes_metadata_and_provenance(
    tmp_path: Path,
    migrated_db_url: str,
    make_settings: Any,
    make_client: Any,
) -> None:
    runs_dir = tmp_path / "runs"
    wrapper = make_client(
        make_settings(
            NEXUS_DATABASE_URL=migrated_db_url,
            NEXUS_STORAGE_ROOT=tmp_path / "storage",
            NEXUS_RUNS_DIR=runs_dir,
        )
    )
    async with wrapper as client:
        database = wrapper.app.state.db
        registrar = wrapper.app.state.artifacts
        async with database.sessionmaker() as session:
            engineer = await session.scalar(
                select(Employee).where(Employee.department == "engineering")
            )
            ceo = await session.scalar(
                select(Employee).where(Employee.role.ilike("%chief executive%"))
            )
            assert engineer is not None and ceo is not None
            conversation = Conversation(
                id="cnv_dc6",
                kind="employee",
                department="engineering",
                employee_id=engineer.id,
                title="DC-6 sources",
            )
            session.add(conversation)
            await session.flush()
            message = Message(
                conversation_id=conversation.id,
                role="owner",
                content="Use this source",
                status="complete",
                finished_at=datetime.now(UTC),
            )
            session.add(message)
            await session.flush()
            attachment = Attachment(
                id="att_dc6",
                message_id=message.id,
                filename="brief.txt",
                content_type="text/plain",
                size=12,
                readable=True,
                text="owner source",
                data=b"owner source",
            )
            task = Task(
                id="tsk_dc6",
                title="Launch analysis",
                description="Write the analysis",
                department="engineering",
                assignee_id=engineer.id,
                status="done",
                kind="manual",
                result="# Launch\n\nFirst real result.",
                finished_at=datetime.now(UTC),
            )
            workflow = Workflow(
                id="wf_dc6",
                title="Company launch",
                objective="Prepare the launch",
                status="completed",
                ceo_id=ceo.id,
                result="# Final report\n\nReady.",
                max_calls=20,
                finished_at=datetime.now(UTC),
            )
            app = App(id="app_dc6", name="Launch Console", description="A real console")
            version = AppVersion(
                id="av_dc6",
                app_id=app.id,
                number=1,
                request="Build it",
                status="ready",
                max_calls=20,
                finished_at=datetime.now(UTC),
            )
            session.add_all([attachment, task, workflow, app, version])
            await session.flush()
            app_file = AppFile(
                version_id=version.id,
                path="src/index.ts",
                position=0,
                area="frontend",
                purpose="Application entry point",
                action="new",
                employee_id=engineer.id,
                author_name=engineer.name,
                author_role=engineer.role,
                status="written",
                content="export const ready = true;\n",
            )
            run = CodeRun(
                id="run_dc6",
                language="python",
                code="open('report.csv', 'w').write('a,b\\n1,2\\n')",
                code_sha256=sha256(b"run").hexdigest(),
                status="succeeded",
                task_id=task.id,
                employee_id=engineer.id,
                author_name=engineer.name,
                files=[{"name": "report.csv", "size": 8}],
                finished_at=datetime.now(UTC),
            )
            session.add_all([app_file, run])
            await session.commit()
            await session.refresh(app_file)

        output = runs_dir / run.id / "files" / "report.csv"
        output.parent.mkdir(parents=True)
        output.write_bytes(b"a,b\n1,2\n")

        assert (await registrar.register_attachment(attachment.id)).registered == 1
        assert (await registrar.register_task(task.id)).registered == 1
        assert (await registrar.register_workflow(workflow.id)).registered == 1
        assert (await registrar.register_app_version(version.id)).registered == 1
        assert (await registrar.register_code_run(run.id)).registered == 1

        async with database.sessionmaker() as session:
            files = list(
                await session.scalars(select(StorageEntry).where(StorageEntry.kind == "file"))
            )
            assert len(files) == 5
            assert {entry.artifact_type for entry in files} == {
                "chat-attachment",
                "task-result",
                "workflow-report",
                "app-source",
                "code-run-output",
            }
            tags = list(await session.scalars(select(StorageTag)))
            generated = {tag.entry_id for tag in tags if tag.tag_key == "ai-generated"}
            assert len(generated) == 4
            links = list(await session.scalars(select(StorageLink)))
            assert {link.target_type for link in links} >= {
                "message",
                "task",
                "workflow",
                "app",
                "app_version",
                "app_file",
                "code_run",
            }
            by_type = {entry.artifact_type: entry for entry in files}

        expected = {
            "chat-attachment": b"owner source",
            "task-result": b"# Launch\n\nFirst real result.",
            "workflow-report": b"# Final report\n\nReady.",
            "app-source": b"export const ready = true;\n",
            "code-run-output": b"a,b\n1,2\n",
        }
        for artifact_type, data in expected.items():
            response = await client.get(
                f"/api/storage/entries/{by_type[artifact_type].id}/download"
            )
            assert response.status_code == 200, response.text
            assert response.content == data


async def test_registration_is_idempotent_versions_changes_and_logs_missing_outputs(
    tmp_path: Path,
    migrated_db_url: str,
    make_settings: Any,
    make_client: Any,
) -> None:
    runs_dir = tmp_path / "runs"
    wrapper = make_client(
        make_settings(
            NEXUS_DATABASE_URL=migrated_db_url,
            NEXUS_STORAGE_ROOT=tmp_path / "storage",
            NEXUS_RUNS_DIR=runs_dir,
        )
    )
    async with wrapper:
        database = wrapper.app.state.db
        registrar = wrapper.app.state.artifacts
        async with database.sessionmaker() as session:
            engineer = await session.scalar(
                select(Employee).where(Employee.department == "engineering")
            )
            assert engineer is not None
            task = Task(
                id="tsk_versions",
                title="Versioned result",
                description="Create a result",
                department="engineering",
                assignee_id=engineer.id,
                status="done",
                kind="manual",
                result="Version one",
                finished_at=datetime.now(UTC),
            )
            missing_run = CodeRun(
                id="run_missing",
                language="python",
                code="print('missing')",
                code_sha256=sha256(b"missing").hexdigest(),
                status="succeeded",
                task_id=task.id,
                employee_id=engineer.id,
                files=[{"name": "missing.txt", "size": 3}],
                finished_at=datetime.now(UTC),
            )
            session.add(task)
            await session.flush()
            session.add(missing_run)
            await session.commit()

        assert (await registrar.register_task(task.id)).registered == 1
        assert (await registrar.register_task(task.id)).registered == 1
        async with database.sessionmaker() as session:
            task.result = "Version two"
            stored_task = await session.get(Task, task.id)
            assert stored_task is not None
            stored_task.result = "Version two"
            await session.commit()
        assert (await registrar.register_task(task.id)).registered == 1
        missing = await registrar.register_code_run(missing_run.id)
        assert missing.failed == 1 and missing.registered == 0

        async with database.sessionmaker() as session:
            entry = await session.scalar(
                select(StorageEntry)
                .join(StorageLink, StorageLink.entry_id == StorageEntry.id)
                .where(
                    StorageLink.target_type == "task",
                    StorageLink.target_id == task.id,
                    StorageLink.relation == "result",
                )
            )
            assert entry is not None
            versions = list(
                await session.scalars(
                    select(StorageVersion)
                    .where(StorageVersion.entry_id == entry.id)
                    .order_by(StorageVersion.number)
                )
            )
            assert [version.number for version in versions] == [1, 2]
            assert len({link.entry_id for link in await session.scalars(select(StorageLink))}) == 1
            failure = await session.scalar(
                select(StorageEvent).where(
                    StorageEvent.kind == "artifact_registration_failed",
                    StorageEvent.level == "error",
                )
            )
            assert failure is not None
            assert failure.details == {
                "source_type": "code_run",
                "source_id": missing_run.id,
            }
            run_entries = await session.scalar(
                select(StorageEntry).where(StorageEntry.path.contains(missing_run.id))
            )
            assert run_entries is None


async def test_repeated_chat_attachment_names_remain_distinct(
    tmp_path: Path,
    migrated_db_url: str,
    make_settings: Any,
    make_client: Any,
) -> None:
    wrapper = make_client(
        make_settings(
            NEXUS_DATABASE_URL=migrated_db_url,
            NEXUS_STORAGE_ROOT=tmp_path / "storage",
        )
    )
    async with wrapper as client:
        database = wrapper.app.state.db
        registrar = wrapper.app.state.artifacts
        async with database.sessionmaker() as session:
            engineer = await session.scalar(
                select(Employee).where(Employee.department == "engineering")
            )
            assert engineer is not None
            conversation = Conversation(
                id="cnv_repeated",
                kind="employee",
                department="engineering",
                employee_id=engineer.id,
                title="Repeated names",
            )
            session.add(conversation)
            await session.flush()
            message = Message(
                conversation_id=conversation.id,
                role="owner",
                content="Two revisions",
                status="complete",
                finished_at=datetime.now(UTC),
            )
            session.add(message)
            await session.flush()
            attachments = [
                Attachment(
                    id=f"att_repeat_{number}",
                    message_id=message.id,
                    filename="brief.txt",
                    content_type="text/plain",
                    size=len(data),
                    readable=True,
                    text=data.decode(),
                    data=data,
                )
                for number, data in enumerate([b"first", b"second"], start=1)
            ]
            session.add_all(attachments)
            await session.commit()

        for attachment in attachments:
            assert (await registrar.register_attachment(attachment.id)).registered == 1
        async with database.sessionmaker() as session:
            entries = list(
                await session.scalars(
                    select(StorageEntry).where(StorageEntry.artifact_type == "chat-attachment")
                )
            )
            assert len(entries) == 2
            assert len({entry.path for entry in entries}) == 2
        contents = set()
        for entry in entries:
            response = await client.get(f"/api/storage/entries/{entry.id}/download")
            contents.add(response.content)
        assert contents == {b"first", b"second"}


async def test_employee_artifact_tools_are_confined_to_their_department(
    tmp_path: Path,
    migrated_db_url: str,
    make_settings: Any,
    make_client: Any,
) -> None:
    wrapper = make_client(
        make_settings(
            NEXUS_DATABASE_URL=migrated_db_url,
            NEXUS_STORAGE_ROOT=tmp_path / "storage",
        )
    )
    async with wrapper:
        database = wrapper.app.state.db
        registrar = wrapper.app.state.artifacts
        async with database.sessionmaker() as session:
            engineer = await session.scalar(
                select(Employee).where(Employee.department == "engineering")
            )
            assert engineer is not None
            task = Task(
                id="tsk_tool_link",
                title="Controlled tool source",
                description="Link target",
                department="engineering",
                assignee_id=engineer.id,
                status="open",
                kind="manual",
            )
            session.add(task)
            await session.commit()

        saved = await registrar.save_text(
            engineer.id,
            filename="notes.md",
            content="Real employee notes",
            folder=["Working Notes"],
            description="Created through the controlled artifact adapter",
            tags=["draft"],
        )
        assert saved["workspace_id"] == "ws_department:engineering"
        assert saved["path"] == "Working Notes/notes.md"
        created_folder = await registrar.create_folder(
            engineer.id, name="Published", folder=["Working Notes"]
        )
        assert created_folder["path"] == "Working Notes/Published"
        updated = await registrar.update(
            engineer.id,
            saved["id"],
            description="Controlled artifact, reviewed",
            artifact_type="working-note",
            tags=["draft", "reviewed"],
        )
        assert updated["artifact_type"] == "working-note"
        linked = await registrar.link(
            engineer.id,
            saved["id"],
            target_type="task",
            target_id=task.id,
            relation="source",
            label=task.title,
        )
        assert linked["target_id"] == task.id
        results = await registrar.search(engineer.id, query="controlled artifact")
        assert [item["id"] for item in results["items"]] == [saved["id"]]
        listed = await registrar.list(engineer.id)
        assert [item["id"] for item in listed["items"]] == [saved["id"]]
        download = await registrar.read(engineer.id, saved["id"])
        chunks = [chunk async for chunk in download.stream]
        assert b"".join(chunks) == b"Real employee notes"
