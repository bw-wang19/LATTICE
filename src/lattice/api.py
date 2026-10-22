"""HTTP API and optional built chat/graph frontend. Run with `lattice serve`."""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.types import Scope

from . import __version__
from .config import Settings, load_settings
from .context import ContextBudgetExceeded
from .domain import Conversation, ConversationGraph, ParentMode, TurnNode
from .service import ChatService, ModelInvocationError
from .storage import ConcurrentTurnError, ConversationNotFound, GraphValidationError, TurnNotFound


class ConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="Untitled conversation", max_length=200)
    instructions: str = Field(default="", max_length=20000)


class ParentControls(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_mode: ParentMode = "auto"
    parent_ids: list[str] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def valid_parent_controls(self):
        if self.parent_mode == "auto" and self.parent_ids:
            raise ValueError("Use augment or manual mode to provide parent IDs.")
        if len(self.parent_ids) != len(set(self.parent_ids)):
            raise ValueError("Duplicate parent IDs are not allowed.")
        if any(not item.strip() for item in self.parent_ids):
            raise ValueError("Parent IDs must be nonempty strings.")
        return self


class TurnCreate(ParentControls):
    question: str = Field(min_length=1, max_length=100000)

    @field_validator("question")
    @classmethod
    def nonempty_question(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Question must not be blank.")
        return value


class ChatCreate(TurnCreate):
    conversation_id: str | None = None


class RegenerateCreate(ParentControls):
    expected_revision: int | None = Field(default=None, ge=1, strict=True)


class FrontendFiles(StaticFiles):
    """Keep unknown API paths out of the frontend's static directory."""

    async def get_response(self, path: str, scope: Scope):
        if path == "api" or path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "Not Found"})
        return await super().get_response(path, scope)


def create_app(
    config_path: str | Path | None = None,
    *,
    settings: Settings | None = None,
    frontend_dist: str | Path | None = None,
) -> FastAPI:
    settings = settings or load_settings(config_path)
    service = ChatService(settings)
    app = FastAPI(
        title="LATTICE",
        description="Automatic conversation DAG and topology-informed context management.",
        version=__version__,
    )
    app.state.service = service
    if settings.server.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.server.cors_origins,
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type"],
        )

    @app.exception_handler(ConversationNotFound)
    @app.exception_handler(TurnNotFound)
    async def not_found(_request: Request, _error: Exception):
        return JSONResponse(status_code=404, content={"detail": "Conversation or turn not found."})

    @app.exception_handler(ContextBudgetExceeded)
    @app.exception_handler(GraphValidationError)
    async def budget_error(_request: Request, error: ContextBudgetExceeded):
        return JSONResponse(status_code=422, content={"detail": str(error)})

    @app.exception_handler(ConcurrentTurnError)
    async def concurrent_error(_request: Request, error: ConcurrentTurnError):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @app.exception_handler(ModelInvocationError)
    async def model_error(_request: Request, error: ModelInvocationError):
        return JSONResponse(status_code=502, content={"detail": str(error)})

    @app.get("/healthz")
    def health():
        return {
            "status": "ok",
            "name": "LATTICE",
            "version": __version__,
            "answer_provider": settings.models.answer.provider,
            "routing_strategy": settings.routing.strategy,
        }

    @app.post("/api/conversations", response_model=Conversation, status_code=201)
    def create_conversation(body: ConversationCreate | None = None):
        body = body or ConversationCreate()
        return service.create_conversation(body.title, body.instructions)

    @app.get("/api/conversations", response_model=list[Conversation])
    def list_conversations():
        return service.repository.list_conversations()

    @app.get("/api/conversations/{conversation_id}/graph", response_model=ConversationGraph)
    def graph(conversation_id: str):
        return service.repository.get_graph(conversation_id)

    @app.get("/api/conversations/{conversation_id}/turns", response_model=list[TurnNode])
    def turns(conversation_id: str):
        return service.repository.list_turns(conversation_id)

    @app.post(
        "/api/conversations/{conversation_id}/turns", response_model=TurnNode, status_code=201
    )
    async def add_turn(conversation_id: str, body: TurnCreate):
        return await service.chat(
            body.question,
            conversation_id,
            parent_mode=body.parent_mode,
            parent_ids=body.parent_ids,
        )

    @app.post("/api/chat", response_model=TurnNode, status_code=201)
    async def chat(body: ChatCreate):
        return await service.chat(
            body.question,
            body.conversation_id,
            parent_mode=body.parent_mode,
            parent_ids=body.parent_ids,
        )

    @app.get("/api/turns/{node_id}", response_model=TurnNode)
    def turn(node_id: str):
        return service.repository.get_turn(node_id)

    @app.get("/api/turns/{node_id}/versions", response_model=list[TurnNode])
    def versions(node_id: str):
        return service.repository.list_versions(node_id)

    @app.post("/api/turns/{node_id}/regenerate", response_model=ConversationGraph)
    async def regenerate(node_id: str, body: RegenerateCreate | None = None):
        body = body or RegenerateCreate()
        return await service.regenerate(
            node_id,
            parent_mode=body.parent_mode,
            parent_ids=body.parent_ids,
            expected_revision=body.expected_revision,
        )

    # Register static files last so API routes, health checks, and docs take precedence.
    build_dir = (
        Path(frontend_dist)
        if frontend_dist is not None
        else Path(__file__).resolve().parents[2] / "frontend" / "dist"
    )
    if (build_dir / "index.html").is_file():
        app.mount("/", FrontendFiles(directory=build_dir, html=True), name="frontend")

    # TODO(streaming): SSE events for selected parents, answer deltas, and graph commits.
    return app
