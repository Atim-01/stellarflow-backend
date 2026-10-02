// services/websocket/main.py
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import redis.asyncio as redis

app = FastAPI()
redis_client = redis.Redis(host='localhost', port=6379, decode_responses=True)

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception:
                pass

manager = ConnectionManager()

async def redis_listener():
    pubsub = redis_client.pubsub()
    await pubsub.subscribe("trade_updates", "price_updates", "notifications")
    async for message in pubsub.listen():
        if message["type"] == "message":
            await manager.broadcast(message["data"])

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(redis_listener())

@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket)