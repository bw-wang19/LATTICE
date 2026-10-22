"""Transactional conversation DAGs, answer versions, and optimistic revisions."""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .domain import Conversation, ConversationGraph, DependencyEdge, TurnNode


class ConversationNotFound(LookupError):
    pass


class TurnNotFound(LookupError):
    pass


class GraphValidationError(ValueError):
    pass


class ConcurrentTurnError(RuntimeError):
    pass


def descendants(nodes: list[TurnNode], node_id: str) -> set[str]:
    """Reachable children, including stale children, independent of sequence."""
    children: dict[str, list[str]] = {}
    for node in nodes:
        for parent in node.parent_ids:
            children.setdefault(parent, []).append(node.id)
    found: set[str] = set()
    pending = list(children.get(node_id, []))
    while pending:
        child = pending.pop()
        if child not in found:
            found.add(child)
            pending.extend(children.get(child, []))
    return found


class Repository:
    """Persist raw versions and actual context snapshots independently of graph edits.

    Conversation revisions detect concurrent changes even when turn count stays
    constant. Regeneration replaces incoming edges and preserves outgoing edges.
    """

    def __init__(self, database_path: str | Path):
        self.path = Path(database_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    instructions TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS turns (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id),
                    sequence INTEGER NOT NULL CHECK(sequence > 0),
                    payload TEXT NOT NULL,
                    UNIQUE(conversation_id, sequence)
                );
                CREATE INDEX IF NOT EXISTS turns_conversation_sequence
                    ON turns(conversation_id, sequence);
                CREATE TABLE IF NOT EXISTS edges (
                    source TEXT NOT NULL REFERENCES turns(id),
                    target TEXT NOT NULL REFERENCES turns(id),
                    PRIMARY KEY(source, target),
                    CHECK(source != target)
                );
                CREATE TABLE IF NOT EXISTS turn_versions (
                    node_id TEXT NOT NULL REFERENCES turns(id),
                    revision INTEGER NOT NULL CHECK(revision > 0),
                    payload TEXT NOT NULL,
                    PRIMARY KEY(node_id, revision)
                );
                """
            )
            connection.execute("BEGIN IMMEDIATE")
            columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(conversations)")
            }
            if "revision" not in columns:
                connection.execute(
                    "ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
                )

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _conversation(connection: sqlite3.Connection, conversation_id: str) -> Conversation:
        row = connection.execute(
            "SELECT payload, revision FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if row is None:
            raise ConversationNotFound(conversation_id)
        return Conversation.model_validate_json(row["payload"]).model_copy(
            update={"revision": row["revision"]}
        )

    @staticmethod
    def _turns(connection: sqlite3.Connection, conversation_id: str) -> list[TurnNode]:
        rows = connection.execute(
            "SELECT payload FROM turns WHERE conversation_id = ? ORDER BY sequence",
            (conversation_id,),
        ).fetchall()
        return [TurnNode.model_validate_json(row["payload"]) for row in rows]

    @staticmethod
    def _version(connection: sqlite3.Connection, node: TurnNode) -> None:
        # Legacy answer versions are backfilled only when read or replaced.
        connection.execute(
            "INSERT OR IGNORE INTO turn_versions(node_id, revision, payload) VALUES (?, ?, ?)",
            (node.id, node.revision, node.model_dump_json()),
        )

    @staticmethod
    def _advance(connection: sqlite3.Connection, conversation: Conversation) -> None:
        updated = conversation.model_copy(update={"revision": conversation.revision + 1})
        changed = connection.execute(
            "UPDATE conversations SET revision = ?, payload = ? WHERE id = ? AND revision = ?",
            (updated.revision, updated.model_dump_json(), updated.id, conversation.revision),
        ).rowcount
        if changed != 1:
            raise ConcurrentTurnError("Conversation changed; refresh the graph and retry.")

    @staticmethod
    def _check_snapshot(conversation: Conversation, expected_revision: int | None) -> None:
        if expected_revision is not None and conversation.revision != expected_revision:
            raise ConcurrentTurnError("Conversation changed; refresh the graph and retry.")

    @staticmethod
    def _validate_parents(
        node: TurnNode, history: list[TurnNode], *, regenerating: bool = False
    ) -> None:
        if len(node.parent_ids) != len(set(node.parent_ids)):
            raise GraphValidationError("Duplicate parent IDs are not allowed.")
        by_id = {item.id: item for item in history}
        blocked = descendants(history, node.id) | {node.id} if regenerating else set()
        for parent_id in node.parent_ids:
            parent = by_id.get(parent_id)
            if parent is None or parent.conversation_id != node.conversation_id:
                raise GraphValidationError(
                    "Parents must be existing turns in the same conversation."
                )
            if parent_id in blocked:
                raise GraphValidationError("A turn cannot depend on itself or its descendants.")
            if not regenerating and parent.sequence >= node.sequence:
                raise GraphValidationError("New turns can only depend on earlier existing turns.")
            if parent.stale:
                raise GraphValidationError("A selected parent is stale; regenerate it first.")
        for item in node.context.items:
            source = by_id.get(item.node_id)
            if source is None or source.stale or source.revision != item.revision:
                raise ConcurrentTurnError("Context source changed; refresh the graph and retry.")

    def create_conversation(self, title: str = "Untitled conversation", instructions: str = ""):
        conversation = Conversation(title=title, instructions=instructions)
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO conversations(id, title, instructions, created_at, payload, revision) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    conversation.id,
                    conversation.title,
                    conversation.instructions,
                    conversation.created_at.isoformat(),
                    conversation.model_dump_json(),
                    conversation.revision,
                ),
            )
        return conversation

    def get_conversation(self, conversation_id: str) -> Conversation:
        with self._connection() as connection:
            return self._conversation(connection, conversation_id)

    def list_conversations(self) -> list[Conversation]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT payload, revision FROM conversations ORDER BY created_at DESC, id"
            ).fetchall()
        return [
            Conversation.model_validate_json(row["payload"]).model_copy(
                update={"revision": row["revision"]}
            )
            for row in rows
        ]

    def list_turns(self, conversation_id: str) -> list[TurnNode]:
        return self.get_graph(conversation_id).nodes

    def get_turn(self, node_id: str) -> TurnNode:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT payload FROM turns WHERE id = ?", (node_id,)
            ).fetchone()
        if row is None:
            raise TurnNotFound(node_id)
        return TurnNode.model_validate_json(row["payload"])

    def list_versions(self, node_id: str) -> list[TurnNode]:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT payload FROM turns WHERE id = ?", (node_id,)
            ).fetchone()
            if row is None:
                raise TurnNotFound(node_id)
            current = TurnNode.model_validate_json(row["payload"])
            self._version(connection, current)
            rows = connection.execute(
                "SELECT payload FROM turn_versions WHERE node_id = ? ORDER BY revision", (node_id,)
            ).fetchall()
        versions = [TurnNode.model_validate_json(row["payload"]) for row in rows]
        # Staleness is graph metadata rather than a new generated answer version.
        return [current if item.revision == current.revision else item for item in versions]

    def save_turn(self, node: TurnNode, *, expected_revision: int | None = None) -> TurnNode:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            conversation = self._conversation(connection, node.conversation_id)
            self._check_snapshot(conversation, expected_revision)
            history = self._turns(connection, node.conversation_id)
            last = history[-1].sequence if history else 0
            if node.sequence != last + 1:
                raise ConcurrentTurnError("Conversation changed; refresh the graph and retry.")
            if node.revision != 1:
                raise GraphValidationError("New turns must start at revision 1.")
            self._validate_parents(node, history)
            connection.execute(
                "INSERT INTO turns(id, conversation_id, sequence, payload) VALUES (?, ?, ?, ?)",
                (node.id, node.conversation_id, node.sequence, node.model_dump_json()),
            )
            connection.executemany(
                "INSERT INTO edges(source, target) VALUES (?, ?)",
                [(parent_id, node.id) for parent_id in node.parent_ids],
            )
            self._version(connection, node)
            self._advance(connection, conversation)
        return node

    def regenerate_turn(self, node: TurnNode, *, expected_revision: int) -> TurnNode:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            conversation = self._conversation(connection, node.conversation_id)
            self._check_snapshot(conversation, expected_revision)
            history = self._turns(connection, node.conversation_id)
            old = next((item for item in history if item.id == node.id), None)
            if old is None:
                raise TurnNotFound(node.id)
            if node.revision != old.revision + 1:
                raise ConcurrentTurnError("Turn changed; refresh the graph and retry.")
            if (node.sequence, node.question, node.created_at) != (
                old.sequence,
                old.question,
                old.created_at,
            ):
                raise GraphValidationError("Regeneration must preserve the original turn identity.")
            self._validate_parents(node, history, regenerating=True)
            self._version(connection, old)
            connection.execute(
                "UPDATE turns SET payload = ? WHERE id = ?", (node.model_dump_json(), node.id)
            )
            connection.execute("DELETE FROM edges WHERE target = ?", (node.id,))
            connection.executemany(
                "INSERT INTO edges(source, target) VALUES (?, ?)",
                [(parent_id, node.id) for parent_id in node.parent_ids],
            )
            self._version(connection, node)
            affected = descendants(history, node.id)
            for child in history:
                if child.id in affected:
                    stale = child.model_copy(
                        update={
                            "stale": True,
                            "stale_reason": (
                                f"Ancestor {node.id} changed to revision {node.revision}; "
                                "regenerate this turn to refresh its context."
                            ),
                        }
                    )
                    connection.execute(
                        "UPDATE turns SET payload = ? WHERE id = ?",
                        (stale.model_dump_json(), child.id),
                    )
            self._advance(connection, conversation)
        return node

    def get_graph(self, conversation_id: str) -> ConversationGraph:
        with self._connection() as connection:
            connection.execute("BEGIN")
            conversation = self._conversation(connection, conversation_id)
            nodes = self._turns(connection, conversation_id)
            edges = connection.execute(
                "SELECT e.source, e.target FROM edges e "
                "JOIN turns t ON t.id = e.target WHERE t.conversation_id = ? "
                "ORDER BY t.sequence, e.source",
                (conversation_id,),
            ).fetchall()
        return ConversationGraph(
            conversation=conversation,
            nodes=nodes,
            edges=[DependencyEdge(source=row["source"], target=row["target"]) for row in edges],
        )
