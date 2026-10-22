import asyncio
import json

import pytest
from langchain_core.messages import AIMessage

from lattice.config import ContextConfig, RoutingConfig
from lattice.context import ContextBudgetExceeded, ContextBuilder, estimate_message_tokens
from lattice.domain import ParentSelection, TurnNode
from lattice.routing import ParentSelector


def turn(
    node_id: str,
    sequence: int,
    question: str,
    answer: str = "answer",
    parents: list[str] | None = None,
) -> TurnNode:
    return TurnNode(
        id=node_id,
        conversation_id="conversation",
        sequence=sequence,
        question=question,
        answer=answer,
        summary=f"Question: {question}; answer excerpt.",
        parent_ids=parents or [],
    )


def test_automatic_routing_returns_to_old_topic_and_starts_new_root() -> None:
    history = [turn("old", 1, "Transformer 显存优化方法", "梯度检查点减少显存占用。")]
    history.extend(
        turn(f"unrelated-{index}", index + 2, f"番茄种植与浇水技巧{index}") for index in range(30)
    )
    selector = ParentSelector(RoutingConfig(candidate_limit=4))
    old = asyncio.run(selector.select("继续讨论 Transformer 显存优化", history))
    assert "old" in old.parent_ids
    assert "old" in old.candidate_ids
    new = asyncio.run(selector.select("怎样计算太阳系行星轨道？", history))
    assert new.parent_ids == []
    continuation = asyncio.run(selector.select("再详细一点呢？", history))
    assert continuation.parent_ids == [history[-1].id]


def test_invalid_llm_parent_falls_back_without_accepting_external_id() -> None:
    class Model:
        async def ainvoke(self, messages):
            return AIMessage(
                content='{"parent_ids": ["another-conversation-node"], "reason": "test"}'
            )

    selector = ParentSelector(RoutingConfig(strategy="llm"), model=Model())
    selected = asyncio.run(
        selector.select("Python memory allocation", [turn("valid", 1, "Python memory allocation")])
    )
    assert selected.parent_ids == ["valid"]
    assert selected.strategy == "heuristic"
    assert selected.fallback_reason == "llm_invalid_selection"


def test_llm_selection_deduplicates_and_caps_valid_candidates() -> None:
    class Model:
        async def ainvoke(self, messages):
            return AIMessage(
                content='```json\n{"parent_ids": ["a", "a", "b", "c"], '
                '"reason": "combine evidence"}\n```'
            )

    selector = ParentSelector(RoutingConfig(strategy="llm", max_parents=2), model=Model())
    history = [turn("a", 1, "A"), turn("b", 2, "B"), turn("c", 3, "C")]
    selected = asyncio.run(selector.select("combine evidence", history))
    assert selected.parent_ids == ["a", "b"]
    assert selected.strategy == "llm"
    assert selected.fallback_reason is None


def test_single_candidate_limit_can_still_find_an_old_topic() -> None:
    selector = ParentSelector(RoutingConfig(candidate_limit=1))
    history = [turn("old", 1, "Python memory allocation"), turn("new", 2, "Tomato garden watering")]
    selected = asyncio.run(selector.select("Python memory optimization", history))
    assert selected.parent_ids == ["old"]


def test_english_sentence_punctuation_does_not_hide_complementary_parents() -> None:
    history = [
        turn("sqlite", 1, "Explain SQLite backups."),
        turn("postgres", 2, "Explain PostgreSQL replication."),
    ]
    selection = asyncio.run(
        ParentSelector(RoutingConfig()).select(
            "Compare SQLite backups and PostgreSQL replication.", history
        )
    )
    assert set(selection.parent_ids) == {"sqlite", "postgres"}


def test_selector_actual_input_is_budgeted_and_audits_only_visible_candidates() -> None:
    class Model:
        calls = 0
        received_messages = None

        async def ainvoke(self, messages):
            self.calls += 1
            self.received_messages = messages
            payload = json.loads(messages[-1].content)
            selected_id = payload["candidates"][0]["id"]
            return AIMessage(content=json.dumps({"parent_ids": [selected_id], "reason": "test"}))

    model = Model()
    config = RoutingConfig(strategy="llm", max_input_tokens=1500)
    history = [
        turn(f"node-{index}", index + 1, "Transformer 显存优化技术" * 100) for index in range(12)
    ]
    for node in history:
        node.summary = "训练约束与显存优化方法。" * 200
    selection = asyncio.run(ParentSelector(config, model=model).select("Transformer 显存", history))
    assert model.calls == 1
    assert selection.strategy == "llm"
    assert estimate_message_tokens(model.received_messages) <= config.max_input_tokens
    visible = json.loads(model.received_messages[-1].content)["candidates"]
    assert selection.candidate_ids == [node["id"] for node in visible]
    assert 0 < len(visible) < len(history)
    assert len(visible[0]["question"]) < len(history[0].question)


def test_oversized_selector_question_falls_back_without_calling_model() -> None:
    class Model:
        calls = 0

        async def ainvoke(self, messages):
            self.calls += 1
            raise AssertionError("The over-budget question must not reach the model.")

    model = Model()
    selector = ParentSelector(RoutingConfig(strategy="llm", max_input_tokens=1024), model=model)
    selected = asyncio.run(selector.select("Python 内存" * 1000, [turn("old", 1, "Python 内存")]))
    assert model.calls == 0
    assert selected.strategy == "heuristic"
    assert selected.fallback_reason == "selector_input_budget_exceeded"
    assert selected.candidate_ids == ["old"]
    assert "original candidate pool" in selected.reason


def test_multi_parent_ancestors_deduplicate_and_exclude_siblings() -> None:
    history = [
        turn("root", 1, "base assumption"),
        turn("left", 2, "first path", parents=["root"]),
        turn("sibling", 3, "unrelated path", parents=["root"]),
        turn("right", 4, "second path", parents=["root"]),
    ]
    original = [node.model_dump() for node in history]
    builder = ContextBuilder(ContextConfig(max_input_tokens=4096))
    bundle = builder.build(
        "compare", history, ParentSelection(parent_ids=["left", "right"]), "system"
    )
    assert [item.node_id for item in bundle.items] == ["root", "left", "right"]
    assert all(item.representation == "full" for item in bundle.items)
    assert [node.model_dump() for node in history] == original
    messages = builder.messages(bundle, "compare", "system")
    assert len(messages) == 2 + 2 * len(bundle.items)
    assert estimate_message_tokens(messages) == bundle.estimated_input_tokens


def test_budget_keeps_auditable_excerpts_and_retains_stored_originals() -> None:
    history = [turn("root", 1, "old conditions", answer="旧条件" * 2000)]
    history.append(
        turn("parent", 2, "important question", answer="完整原文" * 3000, parents=["root"])
    )
    original_answer = history[1].answer
    builder = ContextBuilder(ContextConfig(max_input_tokens=500, summary_max_chars=150))
    bundle = builder.build(
        "new question", history, ParentSelection(parent_ids=["parent"]), "system"
    )
    assert bundle.estimated_input_tokens <= 500
    assert "parent" in {item.node_id for item in bundle.items}
    assert (
        next(item for item in bundle.items if item.node_id == "parent").representation == "summary"
    )
    assert history[1].answer == original_answer
    included = {item.node_id for item in bundle.items}
    assert included | set(bundle.omitted_node_ids) == {"root", "parent"}
    assert included.isdisjoint(bundle.omitted_node_ids)
    assert (
        estimate_message_tokens(builder.messages(bundle, "new question", "system"))
        == bundle.estimated_input_tokens
    )


def test_budget_rejects_oversized_current_question_instead_of_truncating() -> None:
    builder = ContextBuilder(ContextConfig(max_input_tokens=128))
    with pytest.raises(ContextBudgetExceeded):
        builder.build("不可截断的新问题" * 100, [], ParentSelection(), "system")


def test_ancestor_cap_prefers_direct_parent_and_records_omission() -> None:
    history = [turn("root", 1, "root"), turn("parent", 2, "parent", parents=["root"])]
    bundle = ContextBuilder(ContextConfig(max_ancestor_nodes=1)).build(
        "question", history, ParentSelection(parent_ids=["parent"]), "system"
    )
    assert [item.node_id for item in bundle.items] == ["parent"]
    assert bundle.omitted_node_ids == ["root"]
