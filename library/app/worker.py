from __future__ import annotations

import asyncio
import logging

from app.config import Settings
from app.main import build_service

logger = logging.getLogger("vc-library-worker")


async def worker_loop(poll_seconds: float = 2.0) -> None:
    settings = Settings.from_env()
    service = build_service(settings)
    while True:
        job = await service.repository.claim_next_job(settings.owner_user_id)
        if job is None:
            await asyncio.sleep(poll_seconds)
            continue
        try:
            await service.process_job(settings.owner_user_id, job.id, already_claimed=True)
        except Exception:
            logger.exception("Ingestion job %s failed", job.id)


def run() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(worker_loop())


if __name__ == "__main__":
    run()

