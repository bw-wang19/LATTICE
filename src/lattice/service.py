"""One automatic dependency/context workflow per user turn, with a LangChain agent inside."""

import asyncio
import json
from time import perf_counter
from typing import Any

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.tools import tool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

from .config import Settings
from .context import (
    ContextBudgetExceeded,
    ContextBuilder,
    estimate_message_tokens,
    summarize_turn,
)
from .domain import (
    ContextBundle,
    Conversation,
    ConversationGraph,
    ParentMode,
    ParentSelection,
    TurnNode,
    utc_now,
)
from .models import build_chat_model
from .routing import ParentSelector
from .storage import (
    ConcurrentTurnError,
    GraphValidationError,
    Repository,
    TurnNotFound,
    descendants,
)


class ModelInvocationError(RuntimeError):
    pass


class TurnState(TypedDict, total=False):
    started_at: float
    conversation_id: str
    question: str
    conversation: Conversation
    history: list[TurnNode]
    selection: ParentSelection
    context: ContextBundle
    answer: str
    metrics: dict[str, Any]
    node: TurnNode
    parent_mode: ParentMode
    requested_parent_ids: list[str]
    target_id: str
    target: TurnNode
    expected_turn_revision: int | None


def _text(content: str | list[Any]) -> str:
    if isinstance(content, str):
        return content
    return "".join(
        block if isinstance(block, str) else block.get("text", "")
        for block in content
        if isinstance(block, str) or isinstance(block, dict) and block.get("type") == "text"
    )


class InputBudgetGuard(AgentMiddleware):
    """Check the actual per-call payload, including this turn's tool exchange.

    TODO(research): replace the conservative byte estimator with the configured
    model's tokenizer and account for provider-specific chat templates exactly.
    """

    def __init__(self, limit: int):
        super().__init__()
        self.limit = limit
        self.peak_estimate = 0

    def _check(self, request: ModelRequest) -> None:
        messages: list[BaseMessage] = []
        if request.system_message is not None:
            messages.append(request.system_message)
        messages.extend(request.messages)
        normalized = []
        for message in messages:
            content = message.content
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False)
            if isinstance(message, AIMessage) and message.tool_calls:
                content += json.dumps(message.tool_calls, ensure_ascii=False)
            for field in ("name", "tool_call_id", "invalid_tool_calls"):
                value = getattr(message, field, None)
                if value:
                    content += json.dumps({field: value}, ensure_ascii=False)
            normalized.append(message.model_copy(update={"content": content}))
        estimate = estimate_message_tokens(normalized)
        if request.tools:
            schemas = [convert_to_openai_tool(item) for item in request.tools]
            estimate += len(json.dumps(schemas, ensure_ascii=False).encode("utf-8"))
        self.peak_estimate = max(self.peak_estimate, estimate)
        if estimate > self.limit:
            raise ContextBudgetExceeded(
                f"Agent call requires an estimated {estimate} input tokens including tools; "
                f"configured budget is {self.limit}. Increase context.max_input_tokens or "
                "agent.context_reserve_tokens, or disable agent.enable_context_tool."
            )

    def wrap_model_call(self, request: ModelRequest, handler: Any) -> ModelResponse:
        self._check(request)
        return handler(request)

    async def awrap_model_call(self, request: ModelRequest, handler: Any) -> ModelResponse:
        self._check(request)
        return await handler(request)


class ChatService:
    def __init__(self, settings: Settings, repository: Repository | None = None):
        self.settings = settings
        self.repository = repository or Repository(settings.storage.database_path)
        self.answer_model = build_chat_model(settings.models.answer)
        selector_model = None
        if settings.routing.strategy == "llm":
            selector_model = build_chat_model(settings.models.selector or settings.models.answer)
        self.selector = ParentSelector(settings.routing, selector_model)
        reserve = settings.agent.context_reserve_tokens if settings.agent.enable_context_tool else 0
        if reserve >= settings.context.max_input_tokens:
            raise ValueError("agent.context_reserve_tokens must be smaller than the input budget.")
        context_config = settings.context.model_copy(
            update={"max_input_tokens": settings.context.max_input_tokens - reserve}
        )
        self.context_builder = ContextBuilder(context_config)
        self._locks: dict[str, asyncio.Lock] = {}

        # This execution graph is reusable. The growing conversation DAG is data
        # in SQLite; it is NOT encoded as an ever-growing LangGraph workflow.
        workflow = StateGraph(TurnState)
        workflow.add_node("load_history", self._load_history)
        workflow.add_node("select_parents", self._select_parents)
        workflow.add_node("build_context", self._build_context)
        workflow.add_node("answer", self._answer)
        workflow.add_node("persist", self._persist)
        workflow.add_edge(START, "load_history")
        workflow.add_edge("load_history", "select_parents")
        workflow.add_edge("select_parents", "build_context")
        workflow.add_edge("build_context", "answer")
        workflow.add_edge("answer", "persist")
        workflow.add_edge("persist", END)
        self.workflow = workflow.compile()

    def create_conversation(self, title: str = "Untitled conversation", instructions: str = ""):
        return self.repository.create_conversation(title, instructions)

    @staticmethod
    def _parent_controls(parent_mode: ParentMode, parent_ids: list[str] | None) -> list[str]:
        requested = list(parent_ids or [])
        if parent_mode not in {"auto", "augment", "manual"}:
            raise GraphValidationError("Unknown parent selection mode.")
        if len(requested) > 64:
            raise GraphValidationError("At most 64 explicit parent IDs are allowed.")
        if any(not isinstance(item, str) or not item for item in requested):
            raise GraphValidationError("Parent IDs must be nonempty strings.")
        if len(requested) != len(set(requested)):
            raise GraphValidationError("Duplicate parent IDs are not allowed.")
        if parent_mode == "auto" and requested:
            raise GraphValidationError("Use augment or manual mode to provide parent IDs.")
        return requested

    async def chat(
        self,
        question: str,
        conversation_id: str | None = None,
        *,
        parent_mode: ParentMode = "auto",
        parent_ids: list[str] | None = None,
    ) -> TurnNode:
        question = question.strip()
        if not question:
            raise ValueError("Question must not be empty.")
        requested = self._parent_controls(parent_mode, parent_ids)
        if conversation_id is None:
            if requested:
                raise GraphValidationError("Explicit parents require an existing conversation.")
            conversation_id = self.create_conversation(title=question[:80]).id
        # Serialize turns within one conversation, but allow independent chats.
        # SQLite also detects stale snapshots from another worker at commit time.
        lock = self._locks.setdefault(conversation_id, asyncio.Lock())
        async with lock:
            result = await self.workflow.ainvoke(
                {
                    "started_at": perf_counter(),
                    "conversation_id": conversation_id,
                    "question": question,
                    "metrics": {},
                    "parent_mode": parent_mode,
                    "requested_parent_ids": requested,
                }
            )
            return result["node"]

    async def regenerate(
        self,
        node_id: str,
        *,
        parent_mode: ParentMode = "auto",
        parent_ids: list[str] | None = None,
        expected_revision: int | None = None,
    ) -> ConversationGraph:
        requested = self._parent_controls(parent_mode, parent_ids)
        if expected_revision is not None and expected_revision < 1:
            raise GraphValidationError("Expected turn revision must be positive.")
        target = self.repository.get_turn(node_id)
        lock = self._locks.setdefault(target.conversation_id, asyncio.Lock())
        async with lock:
            await self.workflow.ainvoke(
                {
                    "started_at": perf_counter(),
                    "conversation_id": target.conversation_id,
                    "target_id": node_id,
                    "expected_turn_revision": expected_revision,
                    "parent_mode": parent_mode,
                    "requested_parent_ids": requested,
                    "metrics": {},
                }
            )
            return self.repository.get_graph(target.conversation_id)

    def _system_prompt(self, conversation: Conversation) -> str:
        prompt = self.settings.agent.system_prompt
        if conversation.instructions:
            prompt += "\n\nConversation instructions:\n" + conversation.instructions
        return prompt

    def _load_history(self, state: TurnState) -> dict[str, Any]:
        graph = self.repository.get_graph(state["conversation_id"])
        by_id = {node.id: node for node in graph.nodes}
        result: dict[str, Any] = {"conversation": graph.conversation, "history": graph.nodes}
        blocked: set[str] = set()
        if target_id := state.get("target_id"):
            target = by_id.get(target_id)
            if target is None:
                raise TurnNotFound(target_id)
            expected = state.get("expected_turn_revision")
            if expected is not None and expected != target.revision:
                raise ConcurrentTurnError("Turn changed; refresh the graph and retry.")
            result.update(target=target, question=target.question)
            blocked = descendants(graph.nodes, target_id) | {target_id}
        # Reject invalid forced dependencies before selector or answer model calls.
        for parent_id in state.get("requested_parent_ids", []):
            parent = by_id.get(parent_id)
            if parent is None:
                raise GraphValidationError(
                    "Parents must be existing turns in the same conversation."
                )
            if parent_id in blocked:
                raise GraphValidationError("A turn cannot depend on itself or its descendants.")
            if parent.stale:
                raise GraphValidationError("A selected parent is stale; regenerate it first.")
        return result

    async def _select_parents(self, state: TurnState) -> dict[str, Any]:
        started = perf_counter()
        # Reject an oversized question before ANY potentially paid selector call.
        self.context_builder.build(
            state["question"], [], ParentSelection(), self._system_prompt(state["conversation"])
        )
        mode = state.get("parent_mode", "auto")
        requested = state.get("requested_parent_ids", [])
        if mode == "manual":
            selection = ParentSelection(
                parent_ids=requested,
                strategy="manual",
                reason="Used the exact user-selected direct parents; no automatic selector ran.",
            )
        else:
            blocked: set[str] = set()
            if target := state.get("target"):
                blocked = descendants(state["history"], target.id) | {target.id}
            candidates = [
                node for node in state["history"] if not node.stale and node.id not in blocked
            ]
            selection = await self.selector.select(state["question"], candidates)
            if mode == "augment":
                selection = selection.model_copy(
                    update={"parent_ids": list(dict.fromkeys([*requested, *selection.parent_ids]))}
                )
        selection = selection.model_copy(update={"mode": mode, "requested_parent_ids": requested})
        return {
            "selection": selection,
            "metrics": {
                **state["metrics"],
                "selection_ms": round((perf_counter() - started) * 1000, 2),
            },
        }

    def _build_context(self, state: TurnState) -> dict[str, Any]:
        started = perf_counter()
        bundle = self.context_builder.build(
            state["question"],
            state["history"],
            state["selection"],
            self._system_prompt(state["conversation"]),
        )
        return {
            "context": bundle,
            "metrics": {
                **state["metrics"],
                "context_ms": round((perf_counter() - started) * 1000, 2),
                "configured_input_budget": self.settings.context.max_input_tokens,
            },
        }

    async def _answer(self, state: TurnState) -> dict[str, Any]:
        started = perf_counter()
        bundle = state["context"]
        system_prompt = self._system_prompt(state["conversation"])
        tools = []
        if self.settings.agent.enable_context_tool:

            @tool
            def context_manifest() -> str:
                """Report the selected parents and context size for this turn."""
                return json.dumps(
                    {
                        "parent_ids": state["selection"].parent_ids,
                        "included_nodes": len(bundle.items),
                        "omitted_nodes": len(bundle.omitted_node_ids),
                    }
                )

            tools.append(context_manifest)
        # TODO(tools): add task tools; track any additional historical evidence
        # they retrieve as dependencies, rather than silently bypassing the DAG.
        guard = InputBudgetGuard(self.settings.context.max_input_tokens)
        agent = create_agent(
            model=self.answer_model,
            tools=tools,
            system_prompt=system_prompt,
            middleware=[guard],
        )
        # Each user turn starts with freshly selected history. No shared agent
        # checkpointer can silently re-add the entire chronological transcript.
        messages = self.context_builder.messages(bundle, state["question"], system_prompt)[1:]
        try:
            result = await agent.ainvoke(
                {"messages": messages},
                config={"recursion_limit": self.settings.agent.recursion_limit},
            )
        except ContextBudgetExceeded:
            raise
        except Exception as exc:
            # Provider exceptions can include request bodies. Keep API errors
            # and stored records free of credentials and raw upstream responses.
            raise ModelInvocationError(
                "Answer model request failed. Check endpoint, model, credentials, "
                "and tool-calling support in the selected configuration."
            ) from exc
        trace = result["messages"][len(messages) :]
        final = next(
            (message for message in reversed(trace) if isinstance(message, AIMessage)), None
        )
        answer = _text(final.content) if final else ""
        if not answer.strip():
            raise ModelInvocationError("The answer model returned no text.")
        usage: dict[str, int] = {}
        for message in trace:
            for key, value in (getattr(message, "usage_metadata", None) or {}).items():
                if isinstance(value, int):
                    usage[key] = usage.get(key, 0) + value
        return {
            "answer": answer,
            "metrics": {
                **state["metrics"],
                "answer_ms": round((perf_counter() - started) * 1000, 2),
                "answer_provider": self.settings.models.answer.provider,
                "answer_model": self.settings.models.answer.model,
                "answer_model_calls": sum(isinstance(message, AIMessage) for message in trace),
                "tool_calls": sum(len(getattr(message, "tool_calls", [])) for message in trace),
                "answer_usage": usage,
                "peak_input_estimate": guard.peak_estimate,
                "execution_trace": [
                    {
                        "role": message.type,
                        "content": message.content,
                        **(
                            {"tool_calls": message.tool_calls}
                            if isinstance(message, AIMessage)
                            else {}
                        ),
                    }
                    for message in trace
                ],
            },
        }

    def _persist(self, state: TurnState) -> dict[str, TurnNode]:
        node = TurnNode(
            conversation_id=state["conversation_id"],
            sequence=state["history"][-1].sequence + 1 if state["history"] else 1,
            question=state["question"],
            answer=state["answer"],
            summary=summarize_turn(
                state["question"], state["answer"], self.settings.context.summary_max_chars
            ),
            parent_ids=state["selection"].parent_ids,
            selection=state["selection"],
            context=state["context"],
            metrics={
                **state["metrics"],
                "pipeline_ms": round((perf_counter() - state["started_at"]) * 1000, 2),
            },
        )
        if target := state.get("target"):
            node = node.model_copy(
                update={
                    "id": target.id,
                    "sequence": target.sequence,
                    "created_at": target.created_at,
                    "revision": target.revision + 1,
                    "updated_at": utc_now(),
                    "stale": False,
                    "stale_reason": None,
                }
            )
            saved = self.repository.regenerate_turn(
                node, expected_revision=state["conversation"].revision
            )
        else:
            saved = self.repository.save_turn(
                node, expected_revision=state["conversation"].revision
            )
        return {"node": saved}
