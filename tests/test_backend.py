"""Integration checks for persistence, actual agent execution, and HTTP contracts."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import HumanMessage, ToolMessage

from lattice.api import create_app
from lattice.config import Settings
from lattice.context import ContextBudgetExceeded
from lattice.domain import TurnNode
from lattice.models import MockChatModel
from lattice.service import ChatService, InputBudgetGuard
from lattice.storage import ConcurrentTurnError, GraphValidationError, Repository


def settings_for(tmp_path: Path) -> Settings:
    return Settings.model_validate({"storage": {"database_path": tmp_path / "chat.sqlite3"}})


def test_http_automatic_dag_tool_loop_and_restart(tmp_path):
    settings = settings_for(tmp_path)
    app = create_app(settings=settings)
    with TestClient(app) as client:
        assert client.get("/healthz").json()["answer_provider"] == "mock"
        assert client.get("/docs").status_code == 200
        first = client.post("/api/chat", json={"question": "Explain SQLite backups."})
        assert first.status_code == 201
        sqlite_turn = first.json()
        conversation_id = sqlite_turn["conversation_id"]
        assert sqlite_turn["parent_ids"] == []
        assert sqlite_turn["metrics"]["answer_model_calls"] == 2
        assert sqlite_turn["metrics"]["tool_calls"] == 1
        assert [item["role"] for item in sqlite_turn["metrics"]["execution_trace"]] == [
            "ai",
            "tool",
            "ai",
        ]

        postgres_turn = client.post(
            f"/api/conversations/{conversation_id}/turns",
            json={"question": "Explain PostgreSQL replication."},
        ).json()
        assert postgres_turn["parent_ids"] == []
        combined = client.post(
            "/api/chat",
            json={
                "conversation_id": conversation_id,
                "question": "Compare SQLite backups and PostgreSQL replication.",
            },
        ).json()
        expected_parents = {sqlite_turn["id"], postgres_turn["id"]}
        assert set(combined["parent_ids"]) == expected_parents
        assert {item["node_id"] for item in combined["context"]["items"]} == expected_parents
        assert combined["metrics"]["peak_input_estimate"] <= settings.context.max_input_tokens
        assert "[MOCK]" in combined["answer"]
        assert client.get(f"/api/turns/{combined['id']}").json() == combined

        # Explicit parents require an opt-in selection mode; auto remains the default.
        invalid = client.post(
            f"/api/conversations/{conversation_id}/turns",
            json={"question": "Continue", "parent_ids": [sqlite_turn["id"]]},
        )
        assert invalid.status_code == 422
        assert client.get("/api/conversations/missing/graph").status_code == 404

    # A new application instance restores both raw text and all explicit edges.
    with TestClient(create_app(settings=settings)) as restored:
        graph = restored.get(f"/api/conversations/{conversation_id}/graph").json()
        assert len(graph["nodes"]) == 3
        assert {edge["source"] for edge in graph["edges"]} == expected_parents
        assert {edge["target"] for edge in graph["edges"]} == {combined["id"]}
        assert graph["nodes"][0]["question"] == "Explain SQLite backups."


@pytest.mark.asyncio
async def test_same_conversation_requests_are_serialized(tmp_path):
    service = ChatService(settings_for(tmp_path))
    conversation = service.create_conversation()
    await service.chat("SQLite backup", conversation.id)
    await asyncio.gather(
        service.chat("SQLite backup schedule", conversation.id),
        service.chat("SQLite backup recovery", conversation.id),
    )
    nodes = service.repository.list_turns(conversation.id)
    assert [node.sequence for node in nodes] == [1, 2, 3]
    sequences = {node.id: node.sequence for node in nodes}
    assert all(sequences[parent] < node.sequence for node in nodes for parent in node.parent_ids)


class FailingModel(MockChatModel):
    def _generate(self, *args, **kwargs):
        raise RuntimeError("SECRET-UPSTREAM-BODY")


def test_failed_model_does_not_commit_partial_turn_or_expose_provider_body(tmp_path):
    app = create_app(settings=settings_for(tmp_path))
    service = app.state.service
    conversation = service.create_conversation()
    service.answer_model = FailingModel()
    with TestClient(app) as client:
        response = client.post(
            f"/api/conversations/{conversation.id}/turns", json={"question": "hello"}
        )
    assert response.status_code == 502
    assert "SECRET-UPSTREAM-BODY" not in response.text
    assert service.repository.list_turns(conversation.id) == []
    assert service.repository.get_graph(conversation.id).edges == []


def test_oversized_question_rejected_before_selector_call(tmp_path):
    app = create_app(settings=settings_for(tmp_path))
    service = app.state.service
    conversation = service.create_conversation()

    async def forbidden_selector(*_args):
        pytest.fail("The selector must not run for a question exceeding the answer budget.")

    service.selector.select = forbidden_selector
    with TestClient(app) as client:
        response = client.post(
            f"/api/conversations/{conversation.id}/turns",
            json={"question": "超长问题" * 1500},
        )
    assert response.status_code == 422
    assert service.repository.list_turns(conversation.id) == []


def test_budget_guard_counts_tool_call_metadata():
    request = SimpleNamespace(
        system_message=None,
        messages=[
            HumanMessage(content="hello"),
            ToolMessage(content="ok", tool_call_id="x" * 1000),
        ],
        tools=[],
    )
    with pytest.raises(ContextBudgetExceeded):
        InputBudgetGuard(128)._check(request)


def test_repository_rejects_foreign_parents_and_stale_writes_atomically(tmp_path):
    repository = Repository(tmp_path / "chat.sqlite3")
    first = repository.create_conversation()
    second = repository.create_conversation()

    def node(conversation_id, sequence, parents=None):
        return TurnNode(
            conversation_id=conversation_id,
            sequence=sequence,
            question="raw question",
            answer="raw answer",
            summary="excerpt",
            parent_ids=parents or [],
        )

    existing = repository.save_turn(node(first.id, 1))
    with pytest.raises(GraphValidationError):
        repository.save_turn(node(second.id, 1, [existing.id]))
    assert repository.list_turns(second.id) == []
    assert repository.get_graph(second.id).edges == []
    repository.save_turn(node(first.id, 2, [existing.id]))
    with pytest.raises(ConcurrentTurnError):
        repository.save_turn(node(first.id, 2, [existing.id]))
    assert len(repository.list_turns(first.id)) == 2


def test_conversations_do_not_share_context(tmp_path):
    app = create_app(settings=settings_for(tmp_path))
    with TestClient(app) as client:
        first = client.post("/api/chat", json={"question": "SQLite backup"}).json()
        second = client.post("/api/chat", json={"question": "SQLite backup"}).json()
    assert first["conversation_id"] != second["conversation_id"]
    assert second["parent_ids"] == []
    assert second["context"]["items"] == []
