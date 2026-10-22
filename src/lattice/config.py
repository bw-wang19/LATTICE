"""Validated YAML configuration; credentials normally come from environment variables."""

import os
from pathlib import Path
from typing import Any, Literal

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, SecretStr


class ConfigSection(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)


class ModelConfig(ConfigSection):
    provider: Literal["mock", "openai_compatible", "anthropic"] = "mock"
    model: str = Field(default="lattice-mock", min_length=1)
    base_url: str | None = None
    api_key_env: str | None = None
    api_key: SecretStr | None = Field(default=None, repr=False)
    temperature: float | None = None
    max_tokens: int = Field(default=1024, gt=0)
    timeout: float = Field(default=60, gt=0)
    max_retries: int = Field(default=1, ge=0)
    extra_body: dict[str, Any] = Field(default_factory=dict)


class RoutingConfig(ConfigSection):
    strategy: Literal["heuristic", "llm"] = "heuristic"
    max_input_tokens: int = Field(default=4096, gt=0)
    candidate_limit: int = Field(default=24, gt=0)
    max_parents: int = Field(default=3, gt=0)
    min_score: float = Field(default=0.12, ge=0, le=1)
    fallback_to_recent: bool = True


class ContextConfig(ConfigSection):
    max_input_tokens: int = Field(default=4096, gt=0)
    max_ancestor_nodes: int = Field(default=32, gt=0)
    summary_max_chars: int = Field(default=500, gt=0)


class AgentConfig(ConfigSection):
    system_prompt: str = (
        "你是 LATTICE，一个友好、准确的助手。请根据本轮提供的上下文回答问题，"
        "优先使用用户使用的语言。如果上下文不足，请明确说明，不要编造历史内容。"
    )
    recursion_limit: int = Field(default=12, ge=4)
    enable_context_tool: bool = True
    context_reserve_tokens: int = Field(default=768, ge=0)


class StorageConfig(ConfigSection):
    database_path: Path = Path("data/lattice.sqlite3")


class ServerConfig(ConfigSection):
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    cors_origins: list[str] = Field(default_factory=list)


class ModelsConfig(ConfigSection):
    answer: ModelConfig = Field(default_factory=ModelConfig)
    selector: ModelConfig | None = None


class Settings(ConfigSection):
    server: ServerConfig = Field(default_factory=ServerConfig)
    storage: StorageConfig = Field(default_factory=StorageConfig)
    models: ModelsConfig = Field(default_factory=ModelsConfig)
    routing: RoutingConfig = Field(default_factory=RoutingConfig)
    context: ContextConfig = Field(default_factory=ContextConfig)
    agent: AgentConfig = Field(default_factory=AgentConfig)


def load_settings(path: str | Path | None = None) -> Settings:
    """Load YAML, using explicit path > LATTICE_CONFIG > project config.yaml.

    `.env` never overrides variables already supplied by the shell. Database paths
    are resolved relative to the YAML file, independently of the working directory.
    No provider client is constructed here, so loading sample configs is offline.
    """
    load_dotenv(Path.cwd() / ".env", override=False)
    requested = path if path is not None else os.getenv("LATTICE_CONFIG")
    default_path = Path(__file__).resolve().parents[2] / "config.yaml"
    if not default_path.is_file():
        default_path = Path.cwd() / "config.yaml"
    config_path = Path(requested).expanduser().resolve() if requested else default_path
    load_dotenv(config_path.parent / ".env", override=False)
    # Example configs live in configs/, but share the project's .env.
    if config_path.parent.name == "configs":
        load_dotenv(config_path.parent.parent / ".env", override=False)

    if config_path.is_file():
        with config_path.open(encoding="utf-8") as handle:
            values = yaml.safe_load(handle)
        if values is None:
            values = {}
        if not isinstance(values, dict):
            raise ValueError("The LATTICE configuration must be a YAML mapping.")
    elif requested:
        raise FileNotFoundError(f"LATTICE configuration not found: {config_path}")
    else:
        values = {}

    settings = Settings.model_validate(values)
    database_path = settings.storage.database_path.expanduser()
    if not database_path.is_absolute():
        database_path = config_path.parent / database_path
    settings.storage.database_path = database_path.resolve()
    return settings
