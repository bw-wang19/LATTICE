"""Small local development CLI; all model settings come from YAML."""

import argparse
import asyncio
import json

from .config import load_settings
from .service import ChatService


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lattice", description="LATTICE conversation DAG backend")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="Start the HTTP API and /docs")
    serve.add_argument("--config", help="YAML path; defaults to LATTICE_CONFIG or config.yaml")
    chat = commands.add_parser("chat", help="Run one turn and print its JSON record")
    chat.add_argument("question")
    chat.add_argument("--config")
    chat.add_argument("--conversation-id", help="Continue a saved conversation")
    demo = commands.add_parser("demo", help="Run an offline branching/merge demonstration")
    demo.add_argument("--config")
    return parser


async def _demo(service: ChatService) -> None:
    # Demo must never accidentally consume a paid API budget.
    if (
        service.settings.models.answer.provider != "mock"
        or service.settings.routing.strategy != "heuristic"
    ):
        raise ValueError("The demo requires mock answers and heuristic routing. Use config.yaml.")
    conversation = service.create_conversation("LATTICE offline DAG demo")
    questions = [
        "比较 SQLite 和 PostgreSQL 两种数据库。",
        "SQLite 数据库如何备份？",
        "PostgreSQL 数据库如何实现高可用？",
        "综合 SQLite 备份和 PostgreSQL 高可用这两条思路。",
    ]
    for question in questions:
        node = await service.chat(question, conversation.id)
        print(
            json.dumps(
                {
                    "id": node.id,
                    "question": node.question,
                    "parent_ids": node.parent_ids,
                    "context_nodes": [item.node_id for item in node.context.items],
                    "model_calls": node.metrics["answer_model_calls"],
                    "tool_calls": node.metrics["tool_calls"],
                },
                ensure_ascii=False,
            )
        )
    print(json.dumps({"conversation_id": conversation.id}, ensure_ascii=False))


def main() -> None:
    parser = _parser()
    args = parser.parse_args()
    try:
        settings = load_settings(args.config)
        if args.command == "serve":
            import uvicorn

            from .api import create_app

            uvicorn.run(
                create_app(settings=settings),
                host=settings.server.host,
                port=settings.server.port,
            )
            return
        service = ChatService(settings)
        if args.command == "chat":
            node = asyncio.run(service.chat(args.question, args.conversation_id))
            print(node.model_dump_json(indent=2))
        else:
            asyncio.run(_demo(service))
    except (ValueError, FileNotFoundError, RuntimeError, LookupError) as exc:
        parser.exit(1, f"LATTICE: {exc}\n")


if __name__ == "__main__":
    main()
