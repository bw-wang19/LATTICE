"""Dependency overrides, versioned DAG edits, and stale-context safety contracts."""

import asyncio
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from lattice.api import create_app
from lattice.config import Settings
from lattice.domain import Conversation, ParentSelection, TurnNode
from lattice.models import MockChatModel
from lattice.service import ChatService
from lattice.storage import ConcurrentTurnError, GraphValidationError, Repository


def settings_for(tmp_path, **overrides):
    values = {
        "storage": {"database_path": tmp_path / "parents.sqlite3"},
        "agent": {"enable_context_tool": False},
    }
    values.update(overrides)
    return Settings.model_validate(values)


def raw_turn(repository, conversation_id, sequence, parents=None):
    return repository.save_turn(
        TurnNode(
            conversation_id=conversation_id,
            sequence=sequence,
            question=f"Question {sequence}",
            answer=f"Answer {sequence}",
            summary=f"Summary {sequence}",
            parent_ids=parents or [],
        )
    )


def submit(client, conversation_id, question, mode="manual", parents=None):
    response = client.post(
        f"/api/conversations/{conversation_id}/turns",
        json={
            "question": question,
            "parent_mode": mode,
            "parent_ids": parents or [],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_manual_skips_selector_and_keeps_normal_ancestor_context(tmp_path):
    app = create_app(settings=settings_for(tmp_path))
    service = app.state.service

    async def forbidden(*_args):
        pytest.fail("Manual selection must not invoke the automatic selector.")

    service.selector.select = forbidden
    with TestClient(app) as client:
        conversation = client.post("/api/conversations").json()
        first = submit(client, conversation["id"], "First root")
        second = submit(client, conversation["id"], "Continue", parents=[first["id"]])
        third = submit(client, conversation["id"], "Third", parents=[second["id"]])
        assert third["parent_ids"] == [second["id"]]
        assert [item["node_id"] for item in third["context"]["items"]] == [
            first["id"],
            second["id"],
        ]
        assert third["selection"]["mode"] == "manual"
        assert third["selection"]["requested_parent_ids"] == [second["id"]]
        independent = submit(client, conversation["id"], "Continue", parents=[])
        assert independent["parent_ids"] == []
        assert independent["context"]["items"] == []
        assert (
            client.get(f"/api/conversations/{conversation['id']}/graph").json()["conversation"][
                "revision"
            ]
            == 4
        )


@pytest.mark.asyncio
async def test_augment_keeps_all_forced_parents_and_automatic_reason(tmp_path):
    settings = settings_for(tmp_path, routing={"max_parents": 1})
    service = ChatService(settings)
    conversation = service.create_conversation()
    nodes = [raw_turn(service.repository, conversation.id, index) for index in range(1, 7)]

    async def choose(*_args):
        return ParentSelection(
            parent_ids=[nodes[-1].id, nodes[0].id],
            strategy="heuristic",
            reason="Retained automatic evidence.",
            fallback_reason="test-fallback",
        )

    service.selector.select = choose
    forced = [node.id for node in nodes[:5]]
    result = await service.chat(
        "Combine evidence",
        conversation.id,
        parent_mode="augment",
        parent_ids=forced,
    )
    assert result.parent_ids == [*forced, nodes[-1].id]
    assert result.selection.mode == "augment"
    assert result.selection.requested_parent_ids == forced
    assert result.selection.reason == "Retained automatic evidence."
    assert result.selection.fallback_reason == "test-fallback"


@pytest.mark.parametrize(
    "body",
    [
        {"parent_mode": "auto", "parent_ids": ["any"]},
        {"parent_mode": "manual", "parent_ids": ["x", "x"]},
        {"parent_mode": "manual", "parent_ids": [f"n-{index}" for index in range(65)]},
        {"parent_mode": "manual", "parent_ids": [""]},
        {"parent_mode": "manual", "parent_ids": ["missing"]},
        {"parent_mode": "unknown"},
        {"parent_mode": "manual", "unexpected": True},
    ],
)
def test_invalid_parent_requests_fail_before_any_model_call(tmp_path, body):
    app = create_app(settings=settings_for(tmp_path))
    service = app.state.service
    conversation = service.create_conversation()

    async def forbidden(*_args):
        pytest.fail("Invalid parent controls must fail before the selector runs.")

    service.selector.select = forbidden
    with TestClient(app) as client:
        response = client.post(
            f"/api/conversations/{conversation.id}/turns", json={"question": "Question", **body}
        )
        assert response.status_code == 422
    assert service.repository.get_graph(conversation.id).nodes == []
    assert service.repository.get_conversation(conversation.id).revision == 0


def test_regeneration_versions_restart_and_descendant_snapshots(tmp_path):
    settings = settings_for(tmp_path)
    app = create_app(settings=settings)
    with TestClient(app) as client:
        conversation = client.post("/api/conversations").json()
        conversation_id = conversation["id"]
        first = submit(client, conversation_id, "Original")
        second = submit(client, conversation_id, "Child", parents=[first["id"]])
        third = submit(client, conversation_id, "Grandchild", parents=[second["id"]])
        later = submit(client, conversation_id, "Unrelated later root")
        response = client.post(
            f"/api/turns/{first['id']}/regenerate",
            json={
                "parent_mode": "manual",
                "parent_ids": [later["id"]],
                "expected_revision": 1,
            },
        )
        assert response.status_code == 200, response.text
        graph = response.json()
        current = {node["id"]: node for node in graph["nodes"]}
        updated = current[first["id"]]
        assert graph["conversation"]["revision"] == 5
        assert updated["revision"] == 2
        assert updated["updated_at"]
        assert updated["sequence"] == first["sequence"]
        assert updated["question"] == first["question"]
        assert updated["created_at"] == first["created_at"]
        assert updated["parent_ids"] == [later["id"]]
        for original in (second, third):
            node = current[original["id"]]
            assert node["stale"] and node["stale_reason"]
            assert node["revision"] == 1
            assert node["context"] == original["context"]
            assert node["answer"] == original["answer"]
        assert not current[later["id"]]["stale"]
        edges = {(edge["source"], edge["target"]) for edge in graph["edges"]}
        assert edges == {
            (later["id"], first["id"]),
            (first["id"], second["id"]),
            (second["id"], third["id"]),
        }
        versions = client.get(f"/api/turns/{first['id']}/versions").json()
        assert [node["revision"] for node in versions] == [1, 2]
        assert versions[0] == first
        assert versions[-1] == updated
        conflict = client.post(
            f"/api/turns/{first['id']}/regenerate",
            json={
                "parent_mode": "manual",
                "expected_revision": 1,
            },
        )
        assert conflict.status_code == 409

    with TestClient(create_app(settings=settings)) as restored:
        assert restored.get(f"/api/conversations/{conversation_id}/graph").json() == graph
        assert restored.get(f"/api/turns/{first['id']}/versions").json() == versions
        assert restored.get("/api/turns/missing/versions").status_code == 404
        assert restored.post("/api/turns/missing/regenerate", json={}).status_code == 404


def test_cycle_foreign_stale_and_revision_validation_before_selector(tmp_path):
    app = create_app(settings=settings_for(tmp_path))
    service = app.state.service
    with TestClient(app) as client:
        conversation_id = client.post("/api/conversations").json()["id"]
        first = submit(client, conversation_id, "Root")
        child = submit(client, conversation_id, "Child", parents=[first["id"]])
        foreign = client.post("/api/chat", json={"question": "Other conversation"}).json()

        async def forbidden(*_args):
            pytest.fail("Invalid regeneration must fail before automatic selection.")

        service.selector.select = forbidden
        before = client.get(f"/api/conversations/{conversation_id}/graph").json()
        for parent in (first["id"], child["id"], foreign["id"], "missing"):
            response = client.post(
                f"/api/turns/{first['id']}/regenerate",
                json={
                    "parent_mode": "augment",
                    "parent_ids": [parent],
                },
            )
            assert response.status_code == 422, response.text
        for revision in (0, -1, True):
            assert (
                client.post(
                    f"/api/turns/{first['id']}/regenerate",
                    json={
                        "expected_revision": revision,
                    },
                ).status_code
                == 422
            )
        assert client.get(f"/api/conversations/{conversation_id}/graph").json() == before
        assert (
            client.post(
                f"/api/turns/{first['id']}/regenerate",
                json={
                    "parent_mode": "manual",
                },
            ).status_code
            == 200
        )
        assert (
            client.post(
                f"/api/conversations/{conversation_id}/turns",
                json={
                    "question": "Depends on outdated result",
                    "parent_mode": "augment",
                    "parent_ids": [child["id"]],
                },
            ).status_code
            == 422
        )


def test_later_parent_topological_context_and_stale_refresh(tmp_path):
    app = create_app(settings=settings_for(tmp_path))
    with TestClient(app) as client:
        conversation_id = client.post("/api/conversations").json()["id"]
        first = submit(client, conversation_id, "First")
        child = submit(client, conversation_id, "Child", parents=[first["id"]])
        later = submit(client, conversation_id, "Later independent evidence")
        client.post(
            f"/api/turns/{first['id']}/regenerate",
            json={
                "parent_mode": "manual",
                "parent_ids": [later["id"]],
            },
        ).raise_for_status()
        refreshed = client.post(
            f"/api/turns/{child['id']}/regenerate",
            json={
                "parent_mode": "manual",
                "parent_ids": [first["id"]],
                "expected_revision": 1,
            },
        )
        assert refreshed.status_code == 200
        node = next(item for item in refreshed.json()["nodes"] if item["id"] == child["id"])
        assert not node["stale"]
        assert node["stale_reason"] is None
        assert node["revision"] == 2
        assert [(item["node_id"], item["revision"]) for item in node["context"]["items"]] == [
            (later["id"], 1),
            (first["id"], 2),
        ]
        last = submit(client, conversation_id, "Final", parents=[child["id"]])
        assert [(item["node_id"], item["revision"]) for item in last["context"]["items"]] == [
            (later["id"], 1),
            (first["id"], 2),
            (child["id"], 2),
        ]
        original = client.get(f"/api/turns/{child['id']}/versions").json()[0]
        assert original["context"]["items"][0]["revision"] == 1


@pytest.mark.asyncio
async def test_auto_excludes_stale_self_and_descendants(tmp_path):
    service = ChatService(settings_for(tmp_path))
    conversation = service.create_conversation()
    first = await service.chat("First", conversation.id, parent_mode="manual")
    child = await service.chat(
        "Child", conversation.id, parent_mode="manual", parent_ids=[first.id]
    )
    unrelated = await service.chat("Other", conversation.id, parent_mode="manual")
    await service.regenerate(first.id, parent_mode="manual")
    calls = []

    async def capture(_question, candidates):
        calls.append([node.id for node in candidates])
        return ParentSelection()

    service.selector.select = capture
    await service.regenerate(first.id)
    assert calls == [[unrelated.id]]
    await service.chat("New", conversation.id)
    assert set(calls[-1]) == {first.id, unrelated.id}
    assert child.id not in calls[-1]


class FailingModel(MockChatModel):
    def _generate(self, *args, **kwargs):
        raise RuntimeError("private upstream failure")


def test_failed_regeneration_leaves_everything_unchanged(tmp_path):
    app = create_app(settings=settings_for(tmp_path))
    service = app.state.service
    conversation = service.create_conversation()
    first = raw_turn(service.repository, conversation.id, 1)
    child = raw_turn(service.repository, conversation.id, 2, [first.id])
    before = service.repository.get_graph(conversation.id)
    versions = service.repository.list_versions(first.id)
    service.answer_model = FailingModel()
    with TestClient(app) as client:
        response = client.post(
            f"/api/turns/{first.id}/regenerate",
            json={
                "parent_mode": "manual",
            },
        )
        assert response.status_code == 502
        assert "private upstream failure" not in response.text
    assert service.repository.get_graph(conversation.id) == before
    assert service.repository.list_versions(first.id) == versions
    assert not service.repository.get_turn(child.id).stale


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["append", "regenerate"])
async def test_cross_worker_revision_conflict_with_unchanged_turn_count(tmp_path, operation):
    settings = settings_for(tmp_path)
    first_worker = ChatService(settings)
    second_worker = ChatService(settings)
    conversation = first_worker.create_conversation()
    original = await first_worker.chat("Root", conversation.id, parent_mode="manual")
    entered, release = asyncio.Event(), asyncio.Event()

    class WaitingModel(MockChatModel):
        async def _agenerate(self, messages, **kwargs):
            entered.set()
            await release.wait()
            return self._generate(messages)

    first_worker.answer_model = WaitingModel()
    if operation == "append":
        work = first_worker.chat("New question", conversation.id, parent_mode="manual")
    else:
        work = first_worker.regenerate(original.id, parent_mode="manual", expected_revision=1)
    pending = asyncio.create_task(work)
    await asyncio.wait_for(entered.wait(), timeout=10)
    await second_worker.regenerate(original.id, parent_mode="manual", expected_revision=1)
    release.set()
    with pytest.raises(ConcurrentTurnError):
        await pending
    current = first_worker.repository.get_graph(conversation.id)
    assert len(current.nodes) == 1
    assert current.nodes[0].revision == 2
    assert current.conversation.revision == 2
    assert len(first_worker.repository.list_versions(original.id)) == 2


@pytest.mark.asyncio
async def test_forced_edges_survive_context_budget_omission(tmp_path):
    settings = settings_for(
        tmp_path,
        context={
            "max_input_tokens": 1024,
            "max_ancestor_nodes": 1,
            "summary_max_chars": 64,
        },
    )
    service = ChatService(settings)
    conversation = service.create_conversation()
    parents = [raw_turn(service.repository, conversation.id, index) for index in range(1, 5)]
    result = await service.chat(
        "Combine",
        conversation.id,
        parent_mode="manual",
        parent_ids=[node.id for node in parents],
    )
    assert result.parent_ids == [node.id for node in parents]
    assert len(result.context.items) == 1
    assert set(result.context.omitted_node_ids) == {node.id for node in parents[1:]}
    assert result.context.estimated_input_tokens <= result.context.budget_tokens


def test_legacy_database_migration_and_lazy_version_backfill(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    conversation = Conversation(title="Old data")
    node = TurnNode(
        conversation_id=conversation.id,
        sequence=1,
        question="Original question",
        answer="Original answer",
        summary="Old excerpt",
    )
    old_conversation = conversation.model_dump(mode="json", exclude={"revision"})
    old_node = node.model_dump(
        mode="json",
        exclude={
            "revision",
            "updated_at",
            "stale",
            "stale_reason",
        },
    )
    old_node["selection"].pop("mode")
    old_node["selection"].pop("requested_parent_ids")
    with sqlite3.connect(path) as connection:
        connection.executescript("""
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL,
                created_at TEXT NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE turns (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                payload TEXT NOT NULL, UNIQUE(conversation_id, sequence)
            );
            CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL,
                PRIMARY KEY(source, target));
        """)
        connection.execute(
            "INSERT INTO conversations VALUES (?, ?, ?, ?, ?)",
            (
                conversation.id,
                conversation.title,
                "",
                conversation.created_at.isoformat(),
                json.dumps(old_conversation),
            ),
        )
        connection.execute(
            "INSERT INTO turns VALUES (?, ?, ?, ?)",
            (
                node.id,
                conversation.id,
                1,
                json.dumps(old_node),
            ),
        )
    repository = Repository(path)
    assert repository.get_conversation(conversation.id).revision == 0
    assert repository.get_turn(node.id) == node
    assert repository.list_versions(node.id) == [node]
    assert Repository(path).list_versions(node.id) == [node]
    replacement = node.model_copy(update={"revision": 2, "answer": "Updated answer"})
    repository.regenerate_turn(replacement, expected_revision=0)
    assert [version.answer for version in repository.list_versions(node.id)] == [
        "Original answer",
        "Updated answer",
    ]
    assert repository.get_conversation(conversation.id).revision == 1


def test_repository_rejects_future_sequence_parent(tmp_path):
    repository = Repository(tmp_path / "raw.sqlite3")
    conversation = repository.create_conversation()
    # This cannot occur through append API; enforce it again at the storage boundary.
    later = raw_turn(repository, conversation.id, 1)
    candidate = TurnNode(
        conversation_id=conversation.id,
        sequence=2,
        question="Question",
        answer="Answer",
        summary="Summary",
        parent_ids=[later.id],
    )
    fake_later = later.model_copy(update={"sequence": 3})
    with pytest.raises(GraphValidationError):
        repository._validate_parents(candidate, [fake_later])
