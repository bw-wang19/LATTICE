"""LangChain chat-model factory and a deterministic offline tool-calling model."""

import os
from collections.abc import Callable, Sequence
from typing import Any
from uuid import uuid4

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field

from lattice.config import ModelConfig


class MockChatModel(BaseChatModel):
    """Exercise the real agent/tool loop without a network request.

    This mock never claims to answer questions with a real language model. Binding
    tools returns a separate model so one request cannot mutate another's tools.
    """

    model_name: str = "lattice-mock"
    bound_tool_names: list[str] = Field(default_factory=list, exclude=True)

    @property
    def _llm_type(self) -> str:
        return "lattice-mock"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        return {"model_name": self.model_name}

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> "MockChatModel":
        names = [convert_to_openai_tool(tool)["function"]["name"] for tool in tools]
        return self.model_copy(update={"bound_tool_names": names})

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        last_user_index = next(
            (i for i in range(len(messages) - 1, -1, -1) if isinstance(messages[i], HumanMessage)),
            -1,
        )
        current_turn = messages[last_user_index + 1 :]
        tool_observed = any(isinstance(message, ToolMessage) for message in current_turn)
        if "context_manifest" in self.bound_tool_names and not tool_observed:
            message = AIMessage(
                content="",
                tool_calls=[{"name": "context_manifest", "args": {}, "id": f"mock_{uuid4().hex}"}],
            )
        else:
            question = messages[last_user_index].content if last_user_index >= 0 else ""
            message = AIMessage(
                content=(
                    "[MOCK] 离线演示模式：这不是语言模型生成的真实回答。\n"
                    f"已收到你的问题：{question}\n"
                    "自动父节点选择、上下文组装与 Agent 流程已运行；"
                    "请配置真实模型以获得正式回答。"
                )
            )
        return ChatResult(generations=[ChatGeneration(message=message)])


def _api_key(config: ModelConfig, default_env: str) -> str:
    if config.api_key is not None:
        return config.api_key.get_secret_value()
    variable = config.api_key_env or default_env
    value = os.getenv(variable)
    if not value:
        raise ValueError(
            f"Missing model credential: set {variable} in your environment or .env. "
            "For an unauthenticated local vLLM server, use api_key: EMPTY in the YAML config."
        )
    return value


def build_chat_model(config: ModelConfig) -> BaseChatModel:
    """Create a client without making API calls; network traffic begins at invoke."""
    if config.provider == "mock":
        return MockChatModel(model_name=config.model)

    kwargs: dict[str, Any] = {
        "model": config.model,
        "max_tokens": config.max_tokens,
        "timeout": config.timeout,
        "max_retries": config.max_retries,
    }
    if config.temperature is not None:
        kwargs["temperature"] = config.temperature
    if config.base_url is not None:
        kwargs["base_url"] = config.base_url

    if config.provider == "openai_compatible":
        from langchain_openai import ChatOpenAI

        kwargs["api_key"] = _api_key(config, "OPENAI_API_KEY")
        kwargs["use_responses_api"] = False
        if config.extra_body:
            kwargs["extra_body"] = config.extra_body
        # Use only standard Chat Completions features for vLLM/third-party endpoints.
        return ChatOpenAI(**kwargs)

    if config.provider == "anthropic":
        try:
            from langchain_anthropic import ChatAnthropic
        except ImportError as exc:
            raise RuntimeError(
                "Anthropic support is optional. Install it with: pip install -e '.[anthropic]'"
            ) from exc
        kwargs["api_key"] = _api_key(config, "ANTHROPIC_API_KEY")
        if config.extra_body:
            raise ValueError("extra_body is currently supported only for openai_compatible models.")
        return ChatAnthropic(**kwargs)

    raise ValueError(f"Unsupported model provider: {config.provider}")
