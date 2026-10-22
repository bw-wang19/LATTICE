"""Validate provider configuration and the offline model's actual agent loop."""

import os
from pathlib import Path

import pytest
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import ValidationError

from lattice.config import ModelConfig, Settings, load_settings
from lattice.models import MockChatModel, build_chat_model


def test_relative_storage_path_and_environment_config(tmp_path, monkeypatch):
    config_path = tmp_path / "settings.yaml"
    config_path.write_text("storage:\n  database_path: state/chat.sqlite3\n", encoding="utf-8")
    monkeypatch.setenv("LATTICE_CONFIG", str(config_path))
    settings = load_settings()
    assert settings.storage.database_path == tmp_path / "state/chat.sqlite3"
    assert settings.models.answer.provider == "mock"


def test_dotenv_and_explicit_path_precedence(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("LATTICE_CONFIG", raising=False)
    monkeypatch.delenv("LATTICE_TEST_CREDENTIAL", raising=False)
    (tmp_path / ".env").write_text(
        "LATTICE_CONFIG=missing.yaml\nLATTICE_TEST_CREDENTIAL=from-dotenv\n", encoding="utf-8"
    )
    config_path = tmp_path / "selected.yaml"
    config_path.write_text("{}", encoding="utf-8")
    settings = load_settings(config_path)
    assert settings.models.answer.provider == "mock"
    assert os.environ["LATTICE_TEST_CREDENTIAL"] == "from-dotenv"
    # load_dotenv modifies os.environ directly, so ensure this test restores it.
    monkeypatch.delenv("LATTICE_CONFIG", raising=False)
    monkeypatch.delenv("LATTICE_TEST_CREDENTIAL", raising=False)


def test_unknown_fields_and_invalid_budgets_fail():
    with pytest.raises(ValidationError):
        Settings.model_validate({"routing": {"max_parent": 3}})
    with pytest.raises(ValidationError):
        Settings.model_validate({"context": {"max_input_tokens": 0}})
    with pytest.raises(ValidationError):
        Settings.model_validate({"routing": {"max_input_tokens": 0}})


def test_credentials_are_redacted():
    config = ModelConfig(api_key="not-a-real-secret")
    assert "not-a-real-secret" not in repr(config)
    assert "not-a-real-secret" not in config.model_dump_json()


def test_all_example_configs_load_offline():
    root = Path(__file__).resolve().parents[1]
    for relative in ("config.yaml", "configs/vllm.yaml", "configs/api.yaml"):
        settings = load_settings(root / relative)
        assert settings.storage.database_path.is_absolute()


def test_missing_explicit_config_fails(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_settings(tmp_path / "missing.yaml")


def test_missing_key_is_actionable(monkeypatch):
    monkeypatch.delenv("LATTICE_ABSENT_KEY", raising=False)
    config = ModelConfig(
        provider="openai_compatible", model="test-model", api_key_env="LATTICE_ABSENT_KEY"
    )
    with pytest.raises(ValueError, match="LATTICE_ABSENT_KEY"):
        build_chat_model(config)


def test_openai_compatible_client_config_does_not_call_network():
    model = build_chat_model(
        ModelConfig(
            provider="openai_compatible",
            model="local-model",
            base_url="http://127.0.0.1:8001/v1",
            api_key="EMPTY",
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )
    )
    assert model.model_name == "local-model"
    assert model.openai_api_base == "http://127.0.0.1:8001/v1"
    assert model.extra_body == {"chat_template_kwargs": {"enable_thinking": False}}


def test_mock_binding_is_request_local():
    @tool
    def context_manifest() -> str:
        """Describe the current context."""
        return "No historical nodes."

    original = MockChatModel()
    bound = original.bind_tools([context_manifest])
    assert original.bound_tool_names == []
    assert bound.bound_tool_names == ["context_manifest"]
    first = bound.invoke([HumanMessage(content="你好")])
    assert first.tool_calls[0]["name"] == "context_manifest"
    second = bound.invoke(
        [
            HumanMessage(content="你好"),
            first,
            ToolMessage(content="No historical nodes.", tool_call_id=first.tool_calls[0]["id"]),
        ]
    )
    assert not second.tool_calls
    assert "MOCK" in second.content


@pytest.mark.asyncio
async def test_mock_completes_real_langchain_agent_loop():
    @tool
    def context_manifest() -> str:
        """Describe selected historical nodes."""
        return '{"parent_ids": []}'

    agent = create_agent(model=build_chat_model(ModelConfig()), tools=[context_manifest])
    result = await agent.ainvoke({"messages": [HumanMessage(content="测试新问题")]})
    messages = result["messages"]
    assert any(isinstance(message, ToolMessage) for message in messages)
    assert isinstance(messages[-1], AIMessage)
    assert "MOCK" in messages[-1].content
    assert "测试新问题" in messages[-1].content
