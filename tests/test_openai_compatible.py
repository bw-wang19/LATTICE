"""Exercise actual HTTP requests against a loopback-only fake Chat Completions API.

These tests validate the transport contract used with vLLM/compatible APIs, not
model quality or any remote provider. No external service or credential is used.
"""

import json
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

from lattice.config import ModelConfig, RoutingConfig, Settings
from lattice.domain import TurnNode
from lattice.models import build_chat_model
from lattice.routing import ParentSelector
from lattice.service import ChatService


@dataclass
class LocalEndpoint:
    base_url: str = ""
    requests: list[dict[str, Any]] = field(default_factory=list)
    response_content: str = "本地兼容接口测试回答"


@pytest.fixture
def local_endpoint():
    state = LocalEndpoint()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length))
            state.requests.append(
                {
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "body": body,
                }
            )
            response = {
                "id": "chatcmpl-local-test",
                "object": "chat.completion",
                "created": 1,
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": state.response_content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
            }
            payload = json.dumps(response, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format, *args):
            # Keep successful local test traffic out of pytest output.
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    state.base_url = f"http://127.0.0.1:{server.server_port}/v1"
    thread = Thread(target=lambda: server.serve_forever(poll_interval=0.05), daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def local_model(endpoint: LocalEndpoint):
    return build_chat_model(
        ModelConfig(
            provider="openai_compatible",
            model="local-test-model",
            base_url=endpoint.base_url,
            api_key="dummy-local-test-key",
            max_tokens=64,
            max_retries=0,
            timeout=5,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )
    )


@pytest.mark.asyncio
async def test_chat_completions_http_request_and_response(local_endpoint):
    model = local_model(local_endpoint)
    response = await model.ainvoke(
        [SystemMessage(content="回答本地协议测试。"), HumanMessage(content="你好")]
    )

    assert response.content == "本地兼容接口测试回答"
    assert response.usage_metadata["total_tokens"] == 20
    assert model.use_responses_api is False
    assert len(local_endpoint.requests) == 1
    request = local_endpoint.requests[0]
    assert request["path"] == "/v1/chat/completions"
    assert request["authorization"] == "Bearer dummy-local-test-key"
    assert request["body"]["model"] == "local-test-model"
    assert request["body"]["messages"] == [
        {"role": "system", "content": "回答本地协议测试。"},
        {"role": "user", "content": "你好"},
    ]
    assert request["body"]["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.asyncio
async def test_llm_parent_selector_over_compatible_http_api(local_endpoint):
    local_endpoint.response_content = json.dumps(
        {"parent_ids": ["cpu-limits", "deployment"], "reason": "Requires both branches."}
    )
    history = [
        TurnNode(
            id="cpu-limits",
            conversation_id="local-conversation",
            sequence=1,
            question="What CPU limits apply?",
            answer="Two CPU cores are available.",
            summary="CPU limit: two cores.",
        ),
        TurnNode(
            id="deployment",
            conversation_id="local-conversation",
            sequence=2,
            question="How should deployment work?",
            answer="Use a single worker.",
            summary="Deploy a single worker.",
        ),
    ]
    selector = ParentSelector(RoutingConfig(strategy="llm"), local_model(local_endpoint))
    selection = await selector.select("Combine the CPU limits and deployment plan.", history)

    assert selection.parent_ids == ["cpu-limits", "deployment"]
    assert selection.strategy == "llm"
    assert selection.fallback_reason is None
    assert len(local_endpoint.requests) == 1
    request = local_endpoint.requests[0]
    assert request["path"] == "/v1/chat/completions"
    supplied = json.loads(request["body"]["messages"][-1]["content"])
    assert {candidate["id"] for candidate in supplied["candidates"]} == {
        "cpu-limits",
        "deployment",
    }


@pytest.mark.asyncio
async def test_compatible_model_through_complete_agent_workflow(local_endpoint, tmp_path):
    settings = Settings.model_validate(
        {
            "storage": {"database_path": tmp_path / "chat.sqlite3"},
            "models": {
                "answer": {
                    "provider": "openai_compatible",
                    "model": "local-test-model",
                    "base_url": local_endpoint.base_url,
                    "api_key": "dummy-local-test-key",
                    "max_retries": 0,
                    "timeout": 5,
                }
            },
            "agent": {"enable_context_tool": False},
        }
    )
    service = ChatService(settings)
    first = await service.chat("SQLite backup")
    second = await service.chat("SQLite backup recovery", first.conversation_id)
    assert second.answer == local_endpoint.response_content
    assert second.parent_ids == [first.id]
    assert second.metrics["answer_usage"]["total_tokens"] == 20
    assert second.metrics["answer_model_calls"] == 1
    assert second.metrics["tool_calls"] == 0
    assert len(local_endpoint.requests) == 2
    messages = local_endpoint.requests[-1]["body"]["messages"]
    assert messages[-1] == {"role": "user", "content": "SQLite backup recovery"}
    assert any(message["content"] == first.answer for message in messages)
    assert len(service.repository.get_graph(first.conversation_id).edges) == 1
