// workers/ingestion_worker.py
import asyncio
import signal
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ingestion-worker")

class IngestionWorker:
    def __init__(self):
        self.is_shutting_down = False
        self.in_flight_tasks = set()

    async def process_stream(self):
        logger.info("Ingestion worker started, listening for Redis stream messages...")
        while not self.is_shutting_down:
            try:
                await asyncio.sleep(1) # Simulated polling interval
                if self.is_shutting_down:
                    break
                task = asyncio.create_task(self.handle_job())
                self.in_flight_tasks.add(task)
                task.add_done_callback(self.in_flight_tasks.discard)
            except asyncio.CancelledError:
                break

    async def handle_job(self):
        # Simulate active database write / in-flight job processing
        await asyncio.sleep(3)

    async def shutdown(self, sig):
        logger.info(f"Received exit signal {sig.name}. Initiating graceful shutdown...")
        self.is_shutting_down = True
        
        if self.in_flight_tasks:
            logger.info(f"Waiting for {len(self.in_flight_tasks)} in-flight jobs to complete (15s window)...")
            try:
                await asyncio.wait_for(
                    asyncio.gather(*self.in_flight_tasks, return_exceptions=True),
                    timeout=15.0
                )
            except asyncio.TimeoutError:
                logger.warning("Grace period expired; forcing termination of lingering tasks.")
        
        logger.info("Closing database connections and Redis pools cleanly.")
        # Perform explicit pool closures here

async def main():
    worker = IngestionWorker()
    loop = asyncio.get_running_loop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(worker.shutdown(s)))

    await worker.process_stream()

if __name__ == "__main__":
    asyncio.run(main())