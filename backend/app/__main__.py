"""Run the API server using host/port from settings: ``python -m app [--reload]``."""

from __future__ import annotations

import sys

import uvicorn

from app.core.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "app.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        reload="--reload" in sys.argv[1:],
        reload_dirs=["app"],
    )


if __name__ == "__main__":
    main()
