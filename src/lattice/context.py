"""Budgeted ancestor-only context; full history remains in the repository.

UTF-8 byte counts plus fixed message overhead deliberately overestimate common
text tokenization. They are NOT a model tokenizer or an API billing estimate;
provider-added templates/tool schemas need separate headroom at the call site.
"""

from __future__ import annotations

from collections import deque
from heapq import heappop, heappush

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from .config import ContextConfig
from .domain import ContextBundle, ContextItem, ParentSelection, TurnNode


class ContextBudgetExceeded(ValueError):
    """The system instructions and current question alone exceed the input budget."""


def _excerpt(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - 1)] + "…" if max_chars > 0 else ""


def summarize_turn(question: str, answer: str, max_chars: int = 500) -> str:
    """Deterministic, explicitly labelled excerpts; no semantic summary is claimed.

    TODO(research): use dependency-preserving, query-aware summaries with citations.
    """
    question_budget = max(0, (max_chars - 35) // 3)
    answer_budget = max(0, max_chars - question_budget - 35)
    return _excerpt(
        f"Question excerpt: {_excerpt(question, question_budget)}\n"
        f"Answer excerpt: {_excerpt(answer, answer_budget)}",
        max_chars,
    )


def _item_messages(item: ContextItem) -> list[BaseMessage]:
    label = (
        f"[history node={item.node_id} revision={item.revision} "
        f"representation={item.representation}]\n"
    )
    answer = (
        item.answer
        if item.representation == "full"
        else f"[Stored summary / excerpt]\n{item.answer}"
    )
    return [HumanMessage(content=label + item.question), AIMessage(content=answer)]


def estimate_message_tokens(messages: list[BaseMessage]) -> int:
    """A reproducible input budget proxy, including message formatting headroom."""
    total = 16  # request/template envelope
    for message in messages:
        if not isinstance(message.content, str):
            raise ValueError("This text-only context estimator requires string message content.")
        total += len(message.content.encode("utf-8")) + 12
    return total


class ContextBuilder:
    def __init__(self, config: ContextConfig) -> None:
        self.config = config

    @staticmethod
    def messages(bundle: ContextBundle, question: str, system_prompt: str) -> list[BaseMessage]:
        messages: list[BaseMessage] = [SystemMessage(content=system_prompt)]
        for item in bundle.items:
            messages.extend(_item_messages(item))
        messages.append(HumanMessage(content=question))
        return messages

    @staticmethod
    def _item(node: TurnNode, summary_chars: int | None = None) -> ContextItem:
        if summary_chars is None:
            item = ContextItem(
                node_id=node.id,
                revision=node.revision,
                representation="full",
                question=node.question,
                answer=node.answer,
                estimated_tokens=0,
            )
        else:
            item = ContextItem(
                node_id=node.id,
                revision=node.revision,
                representation="summary",
                question=_excerpt(node.question, max(1, summary_chars // 3)),
                answer=_excerpt(
                    node.summary or summarize_turn(node.question, node.answer, summary_chars),
                    summary_chars,
                ),
                estimated_tokens=0,
            )
        # Remove the one-time request envelope; two historical messages are additive.
        item.estimated_tokens = estimate_message_tokens(_item_messages(item)) - 16
        return item

    def build(
        self, question: str, history: list[TurnNode], selection: ParentSelection, system_prompt: str
    ) -> ContextBundle:
        if len({node.conversation_id for node in history}) > 1:
            raise ValueError("Context requires history from one conversation.")
        by_id = {node.id: node for node in history}
        if len(by_id) != len(history):
            raise ValueError("History contains duplicate node IDs.")
        if any(node_id not in by_id for node_id in selection.parent_ids):
            raise ValueError("A selected parent is absent from this conversation's history.")
        bundle = ContextBundle(budget_tokens=self.config.max_input_tokens)
        base_tokens = estimate_message_tokens(self.messages(bundle, question, system_prompt))
        if base_tokens > self.config.max_input_tokens:
            raise ContextBudgetExceeded(
                "System instructions and current question require an estimated "
                f"{base_tokens} input tokens; "
                f"configured budget is {self.config.max_input_tokens}."
            )

        # Breadth-first puts all direct parents before indirect dependencies.
        ordered: list[TurnNode] = []
        visited: set[str] = set()
        queue = deque(selection.parent_ids)
        while queue:
            node_id = queue.popleft()
            if node_id in visited:
                continue
            visited.add(node_id)
            node = by_id.get(node_id)
            if node is None:
                raise ValueError("History contains a dependency on a missing node.")
            ordered.append(node)
            queue.extend(node.parent_ids)

        remaining = self.config.max_input_tokens - base_tokens
        # TODO(research): jointly allocate budget across complementary parents.
        for node in ordered[: self.config.max_ancestor_nodes]:
            item = self._item(node)
            if item.estimated_tokens > remaining:
                item = self._item(node, self.config.summary_max_chars)
                if item.estimated_tokens > remaining:
                    # Keep the largest fitting excerpt; never truncate the new question.
                    low, high = 32, self.config.summary_max_chars
                    fitting: ContextItem | None = None
                    while low <= high:
                        middle = (low + high) // 2
                        candidate = self._item(node, middle)
                        if candidate.estimated_tokens <= remaining:
                            fitting = candidate
                            low = middle + 1
                        else:
                            high = middle - 1
                    if fitting is None:
                        continue
                    item = fitting
            bundle.items.append(item)
            remaining -= item.estimated_tokens

        # Regeneration may link an older turn to a later unrelated turn. Emit
        # ancestor messages topologically, with sequence as the stable tiebreak.
        children: dict[str, list[str]] = {node.id: [] for node in ordered}
        indegree = {node.id: len(set(node.parent_ids)) for node in ordered}
        for node in ordered:
            for parent_id in set(node.parent_ids):
                children[parent_id].append(node.id)
        ready = [(node.sequence, node.id) for node in ordered if not indegree[node.id]]
        # heappush all entries rather than depending on breadth-first input order.
        heap: list[tuple[int, str]] = []
        for entry in ready:
            heappush(heap, entry)
        topological: list[str] = []
        while heap:
            _, node_id = heappop(heap)
            topological.append(node_id)
            for child_id in children[node_id]:
                indegree[child_id] -= 1
                if not indegree[child_id]:
                    heappush(heap, (by_id[child_id].sequence, child_id))
        if len(topological) != len(ordered):
            raise ValueError("History contains a dependency cycle.")
        position = {node_id: index for index, node_id in enumerate(topological)}
        bundle.items.sort(key=lambda item: position[item.node_id])
        included = {item.node_id for item in bundle.items}
        bundle.omitted_node_ids = [node_id for node_id in topological if node_id not in included]
        bundle.estimated_input_tokens = estimate_message_tokens(
            self.messages(bundle, question, system_prompt)
        )
        return bundle
