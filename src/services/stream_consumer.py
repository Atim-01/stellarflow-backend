// workers/stream_consumer.py
import asyncio
import json
import logging
import redis.asyncio as redis

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("stream-consumer")

class LedgerEventConsumer:
    def __init__(self, redis_client, db_pool, stream_key: str, group_name: str, consumer_name: str):
        self.redis = redis_client
        self.db = db_pool
        self.stream_key = stream_key
        self.group_name = group_name
        self.consumer_name = consumer_name

    async def setup_consumer_group(self):
        try:
            await self.redis.xgroup_create(self.stream_key, self.group_name, id="0", mkstream=True)
        except redis.ResponseError as e:
            if "BUSYGROUP" in str(e):
                pass
            else:
                raise

    async def is_processed(self, sequence_number: str) -> bool:
        async with self.db.acquire() as conn:
            res = await conn.fetchval(
                "SELECT 1 FROM processed_ledgers WHERE sequence_number = $1",
                sequence_number
            )
            return res is not None

    async def mark_processed(self, sequence_number: str):
        async with self.db.acquire() as conn:
            await conn.execute(
                "INSERT INTO processed_ledgers (sequence_number, processed_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING",
                sequence_number
            )

    async def claim_stuck_messages(self, min_idle_time_ms: int = 60000):
        pending = await self.redis.xpending_range(self.stream_key, self.group_name, "-", "+", 10)
        for item in pending:
            if item["time_since_delivered"] > min_idle_time_ms:
                claimed = await self.redis.xclaim(
                    self.stream_key, self.group_name, self.consumer_name,
                    min_idle_time_ms, [item["message_id"]]
                )
                for msg_id, fields in claimed:
                    await self.process_message(msg_id, fields)

    async def process_message(self, message_id: str, fields: dict):
        payload = json.loads(fields.get("payload", "{}"))
        seq_num = payload.get("sequence_number")

        if not seq_num or await self.is_processed(seq_num):
            logger.info(f"Duplicate or invalid ledger event detected: {seq_num}. Acknowledging.")
            await self.redis.xack(self.stream_key, self.group_name, message_id)
            return

        try:
            logger.info(f"Processing ledger event sequence: {seq_num}")
            await asyncio.sleep(0.5)

            await self.mark_processed(seq_num)
            await self.redis.xack(self.stream_key, self.group_name, message_id)
        except Exception as e:
            logger.error(f"Failed to process message {message_id}: {e}")

    async def consume_loop(self):
        await self.setup_consumer_group()
        while True:
            try:
                await self.claim_stuck_messages()
                streams = {self.stream_key: ">"}
                messages = await self.redis.xreadgroup(
                    self.group_name, self.consumer_name, streams, count=10, block=2000
                )
                if messages:
                    for stream, msg_list in messages:
                        for message_id, fields in msg_list:
                            await self.process_message(message_id, fields)
            except Exception as e:
                logger.error(f"Error in consumer loop: {e}")
                await asyncio.sleep(2)