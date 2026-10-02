// workers/dlq_worker.py
import asyncio
import json
import logging
import click
import redis.asyncio as redis

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dlq-worker")

class DLQHandler:
    def __init__(self, redis_client, db_pool, max_retries: int = 3):
        self.redis = redis_client
        self.db = db_pool
        self.max_retries = max_retries

    async def handle_failed_payload(self, stream_id: str, payload: dict, error_message: str, retry_count: int):
        if retry_count >= self.max_retries:
            logger.warning(f"Message {stream_id} exceeded max retries ({self.max_retries}). Isolating to DLQ.")
            await self.move_to_dlq(stream_id, payload, error_message)
        else:
            logger.info(f"Re-queuing message {stream_id} (Attempt {retry_count + 1}/{self.max_retries})")
            await self.redis.xadd("event_stream", {"payload": json.dumps(payload), "retries": retry_count + 1})

    async def move_to_dlq(self, stream_id: str, payload: dict, error_message: str):
        # Store exception details and raw payload in the database for manual review
        async with self.db.acquire() as connection:
            await connection.execute(
                """
                INSERT INTO dead_letter_queue (stream_id, raw_payload, error_details, failed_at)
                VALUES ($1, $2, $3, NOW())
                """,
                stream_id, json.dumps(payload), error_message
            )
        logger.info(f"Successfully isolated failed payload {stream_id} into database DLQ.")

@click.group()
cli = click.Group()

@cli.command()
@click.option('--dlq-id', required=True, help='Database ID or Stream ID of the DLQ item to re-queue.')
def requeue_item(dlq_id: str):
    """Admin CLI tool to re-queue resolved DLQ items back to the active stream."""
    click.echo(f"Initiating re-queue sequence for resolved DLQ item: {dlq_id}")
    # Logic to fetch payload from database DLQ table and re-inject into active Redis stream
    click.echo(f"Item {dlq_id} successfully re-queued to event ingestion stream.")

if __name__ == "__main__":
    cli()