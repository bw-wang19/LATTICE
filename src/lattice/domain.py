"""Provider-independent records shared by the API, research strategies, and storage."""

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


def new_id() -> str:
    return uuid4().hex


def utc_now() -> datetime:
    return datetime.now(UTC)


class Conversation(BaseModel):
    id: str = Field(default_factory=new_id)
    title: str = "Untitled conversation"
    instructions: str = ""
    created_at: datetime = Field(default_factory=utc_now)
    revision: int = Field(default=0, ge=0)


ParentMode = Literal["auto", "augment", "manual"]


class ParentSelection(BaseModel):
    parent_ids: list[str] = Field(default_factory=list)
    strategy: str = "heuristic"
    reason: str = ""
    fallback_reason: str | None = None
    candidate_ids: list[str] = Field(default_factory=list)
    mode: ParentMode = "auto"
    requested_parent_ids: list[str] = Field(default_factory=list)


class ContextItem(BaseModel):
    node_id: str
    revision: int = Field(default=1, ge=1)
    representation: Literal["full", "summary"]
    question: str
    answer: str
    estimated_tokens: int


class ContextBundle(BaseModel):
    items: list[ContextItem] = Field(default_factory=list)
    omitted_node_ids: list[str] = Field(default_factory=list)
    estimated_input_tokens: int = 0
    budget_tokens: int = 0
    estimator: str = "utf8_bytes_conservative"


class TurnNode(BaseModel):
    id: str = Field(default_factory=new_id)
    conversation_id: str
    sequence: int
    question: str
    answer: str
    summary: str
    parent_ids: list[str] = Field(default_factory=list)
    selection: ParentSelection = Field(default_factory=ParentSelection)
    context: ContextBundle = Field(default_factory=ContextBundle)
    metrics: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)
    revision: int = Field(default=1, ge=1)
    updated_at: datetime | None = None
    stale: bool = False
    stale_reason: str | None = None


class DependencyEdge(BaseModel):
    source: str
    target: str
    kind: Literal["depends_on"] = "depends_on"


class ConversationGraph(BaseModel):
    conversation: Conversation
    nodes: list[TurnNode]
    edges: list[DependencyEdge]
