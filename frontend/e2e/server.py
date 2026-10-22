"""An isolated offline API for browser checks; never writes the user's chat database."""

from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn

from lattice.api import create_app
from lattice.config import Settings


if __name__ == "__main__":
    with TemporaryDirectory(prefix="lattice-browser-") as temporary:
        settings = Settings.model_validate(
            {"storage": {"database_path": Path(temporary) / "browser.sqlite3"}}
        )
        uvicorn.run(create_app(settings=settings), host="127.0.0.1", port=8021)
