import { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { encode } from "@msgpack/msgpack";
import { WebSocketServer, WebSocket } from "ws";
import { getApiContentSecurityPolicy } from "../middleware/securityHeadersMiddleware";

interface Session {
  id: string; // connectionSessionId
  socketId: string | null;
  status: "connected" | "disconnected-pending";
  lastSeen: number;
  data: any; // Store any session data here
  disconnectTimer?: NodeJS.Timeout;
  messageQueue: { event: string; data: any; useMsgpack?: boolean }[]; // Queue for missed messages
  msgpackEnabled?: boolean; // Indicates if this session prefers MessagePack
}

const sessions = new Map<string, Session>();
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const GRACE_PERIOD = 60000;
const CLEANUP_INTERVAL = 60000;

let io: Server | null = null;
let wss: WebSocketServer | null = null;

interface MarketStreamClient {
  id: string;
  ws: WebSocket;
  pairs: Set<string>;
  msgpackEnabled: boolean;
  lastSeen: number;
  isAlive: boolean;
}

const marketStreamClients = new Map<string, MarketStreamClient>();
const pairSubscribers = new Map<string, Set<string>>();
const MARKET_STREAM_HEARTBEAT = 30000;

interface MarketUpdate {
  pair: string;
  type: "price" | "volume" | "orderbook";
  data: any;
  timestamp: number;
}

const latestMarketState = new Map<string, { price?: any; volume?: any; orderbook?: any }>();

/**
 * Broadcasts an event to all connected clients and queues it for those in grace period.
 */
export function broadcastToSessions(event: string, data: any) {
  if (!io) return;

  // Send to all currently connected sockets individually to respect msgpack settings
  for (const session of sessions.values()) {
    if (session.status === "connected" && session.socketId) {
      const socket = io.sockets.sockets.get(session.socketId);
      if (socket) {
        if (session.msgpackEnabled) {
          socket.emit(event, encode(data));
        } else {
          socket.emit(event, data);
        }
      }
    } else if (session.status === "disconnected-pending") {
      session.messageQueue.push({ event, data, useMsgpack: session.msgpackEnabled });
    }
  }
}

/**
 * Broadcasts a market update to all subscribed market-stream clients.
 * Multiplexes price, volume, and orderbook updates into a single event stream.
 */
export function broadcastMarketUpdate(update: MarketUpdate) {
  const state = latestMarketState.get(update.pair) || {};
  if (update.type === "price") state.price = update.data;
  else if (update.type === "volume") state.volume = update.data;
  else if (update.type === "orderbook") state.orderbook = update.data;
  latestMarketState.set(update.pair, state);

  const subscribers = pairSubscribers.get(update.pair);
  if (!subscribers || subscribers.size === 0) return;

  const payload = {
    pair: update.pair,
    type: update.type,
    data: update.data,
    timestamp: update.timestamp,
  };

  const jsonPayload = JSON.stringify(payload);
  const msgpackPayload = encode(payload);

  for (const clientId of subscribers) {
    const client = marketStreamClients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) continue;
    try {
      if (client.msgpackEnabled) {
        client.ws.send(msgpackPayload);
      } else {
        client.ws.send(jsonPayload);
      }
    } catch (err) {
      console.warn(`⚠️ Failed to send market update to ${clientId}:`, err);
    }
  }
}

/**
 * Returns memory overhead statistics for market-stream clients.
 */
export function getMarketStreamStats() {
  let totalPairs = 0;
  for (const subs of pairSubscribers.values()) totalPairs += subs.size;
  return {
    activeClients: marketStreamClients.size,
    totalPairSubscriptions: totalPairs,
    uniquePairs: pairSubscribers.size,
    estimatedBytesPerClient: 512,
    estimatedTotalBytes: marketStreamClients.size * 512,
  };
}

export function initSocket(server: import("http").Server): Server {
  io = new Server(server, {
    cors: { origin: "*" },
    // Disable built-in heartbeat to use our custom one as requested
    pingInterval: HEARTBEAT_INTERVAL,
    pingTimeout: HEARTBEAT_TIMEOUT,
  });

  io.engine.on("initial_headers", (headers) => {
    headers["content-security-policy"] = getApiContentSecurityPolicy();
    headers["x-frame-options"] = "DENY";
    headers["x-content-type-options"] = "nosniff";
  });

  // Initialize combined market-stream WebSocket endpoint at /v1/market-stream
  initMarketStream(server);

  io.on("connection", (socket: Socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Assign or Resume Session
    socket.on(
      "resume",
      (
        sessionId: string,
        callback: (response: { success: boolean; data?: any }) => void,
      ) => {
        const session = sessions.get(sessionId);
        if (session && session.status === "disconnected-pending") {
          console.log(`🔄 Session resumed: ${sessionId}`);

          if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            delete session.disconnectTimer;
          }

          session.socketId = socket.id;
          session.status = "connected";
          session.lastSeen = Date.now();
          (socket as any).sessionId = sessionId;

          // Send queued messages
          if (session.messageQueue.length > 0) {
            console.log(
              `📨 Delivering ${session.messageQueue.length} queued messages to ${sessionId}`,
            );
            session.messageQueue.forEach((msg) => {
              if (msg.useMsgpack) {
                socket.emit(msg.event, encode(msg.data));
              } else {
                socket.emit(msg.event, msg.data);
              }
            });
            session.messageQueue = [];
          }

          callback({ success: true, data: session.data });
        } else {
          console.log(`❌ Resume failed for session: ${sessionId}`);
          callback({ success: false });
        }
      },
    );

    socket.on("enable_msgpack", () => {
      const sessionId = (socket as any).sessionId;
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          session.msgpackEnabled = true;
          console.log(`📦 Msgpack enabled for session ${sessionId}`);
        }
      }
    });

    socket.on(
      "identify",
      (callback: (response: { sessionId: string }) => void) => {
        const sessionId = randomUUID();
        const session: Session = {
          id: sessionId,
          socketId: socket.id,
          status: "connected",
          lastSeen: Date.now(),
          data: {},
          messageQueue: [],
        };
        sessions.set(sessionId, session);
        (socket as any).sessionId = sessionId;
        console.log(
          `🆕 New session created: ${sessionId} for socket ${socket.id}`,
        );
        callback({ sessionId });
      },
    );

    // Heartbeat Implementation
    const heartbeatInterval = setInterval(() => {
      socket.emit("ping");

      const timeout = setTimeout(() => {
        console.warn(`⚠️ Heartbeat timeout for socket ${socket.id}`);
        socket.disconnect(true); // This will trigger the 'disconnect' event
      }, HEARTBEAT_TIMEOUT);

      socket.once("pong", () => {
        clearTimeout(timeout);
        const sessionId = (socket as any).sessionId;
        if (sessionId) {
          const session = sessions.get(sessionId);
          if (session) session.lastSeen = Date.now();
        }
      });
    }, HEARTBEAT_INTERVAL);

    socket.on("disconnect", (reason) => {
      console.log(`🔌 Client disconnected (${reason}): ${socket.id}`);
      clearInterval(heartbeatInterval);
      handleDisconnect(socket);
    });
  });

  // Cleanup routine
  setInterval(cleanupSessions, CLEANUP_INTERVAL);

  return io;
}

function initMarketStream(server: import("http").Server) {
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url || "", `http://${request.headers.host}`);
      if (url.pathname !== "/v1/market-stream") return;

      const pairsParam = url.searchParams.get("pairs") || "";
      const pairs = pairsParam
        .split(",")
        .map((p) => p.trim().toUpperCase())
        .filter((p) => p.length > 0);

      if (pairs.length === 0) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      wss!.handleUpgrade(request, socket, head, (ws) => {
        wss!.emit("connection", ws, request, pairs);
      });
    } catch (err) {
      console.warn("⚠️ Market stream upgrade failed:", err);
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket, _request: any, pairs: string[]) => {
    const clientId = randomUUID();
    const client: MarketStreamClient = {
      id: clientId,
      ws,
      pairs: new Set(pairs),
      msgpackEnabled: false,
      lastSeen: Date.now(),
      isAlive: true,
    };
    marketStreamClients.set(clientId, client);

    for (const pair of pairs) {
      let subs = pairSubscribers.get(pair);
      if (!subs) {
        subs = new Set();
        pairSubscribers.set(pair, subs);
      }
      subs.add(clientId);
    }

    console.log(`📡 Market stream client ${clientId} subscribed to: ${pairs.join(", ")}`);

    // Send initial snapshot of current state for subscribed pairs
    const snapshot: any = { type: "snapshot", pairs: {} };
    for (const pair of pairs) {
      const state = latestMarketState.get(pair);
      if (state) snapshot.pairs[pair] = state;
    }
    try {
      ws.send(JSON.stringify(snapshot));
    } catch (err) {
      console.warn(`⚠️ Failed to send snapshot to ${clientId}:`, err);
    }

    ws.on("message", (raw: Buffer) => {
      client.lastSeen = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe" && Array.isArray(msg.pairs)) {
          for (const p of msg.pairs) {
            const pair = String(p).toUpperCase();
            if (client.pairs.has(pair)) continue;
            client.pairs.add(pair);
            let subs = pairSubscribers.get(pair);
            if (!subs) {
              subs = new Set();
              pairSubscribers.set(pair, subs);
            }
            subs.add(clientId);
          }
        } else if (msg.type === "unsubscribe" && Array.isArray(msg.pairs)) {
          for (const p of msg.pairs) {
            const pair = String(p).toUpperCase();
            if (!client.pairs.has(pair)) continue;
            client.pairs.delete(pair);
            const subs = pairSubscribers.get(pair);
            if (subs) {
              subs.delete(clientId);
              if (subs.size === 0) pairSubscribers.delete(pair);
            }
          }
        } else if (msg.type === "msgpack") {
          client.msgpackEnabled = true;
        } else if (msg.type === "pong") {
          client.isAlive = true;
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("pong", () => {
      client.isAlive = true;
      client.lastSeen = Date.now();
    });

    ws.on("close", () => {
      cleanupMarketStreamClient(clientId);
    });

    ws.on("error", (err) => {
      console.warn(`⚠️ Market stream client ${clientId} error:`, err);
      cleanupMarketStreamClient(clientId);
    });
  });

  // Heartbeat to detect dead market-stream connections
  setInterval(() => {
    for (const client of marketStreamClients.values()) {
      if (!client.isAlive) {
        try {
          client.ws.terminate();
        } catch {}
        cleanupMarketStreamClient(client.id);
        continue;
      }
      client.isAlive = false;
      try {
        client.ws.ping();
      } catch {}
    }
  }, MARKET_STREAM_HEARTBEAT);
}

function cleanupMarketStreamClient(clientId: string) {
  const client = marketStreamClients.get(clientId);
  if (!client) return;
  for (const pair of client.pairs) {
    const subs = pairSubscribers.get(pair);
    if (subs) {
      subs.delete(clientId);
      if (subs.size === 0) pairSubscribers.delete(pair);
    }
  }
  marketStreamClients.delete(clientId);
  console.log(`🗑️ Market stream client removed: ${clientId}`);
}

function handleDisconnect(socket: Socket) {
  const sessionId = (socket as any).sessionId;
  if (!sessionId) return;

  const session = sessions.get(sessionId);
  if (session) {
    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
    }
    sessions.delete(sessionId);
    console.log(`🗑️ Session force-cleared on disconnect: ${sessionId}`);
  }
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (
      session.status === "disconnected-pending" &&
      now - session.lastSeen > GRACE_PERIOD
    ) {
      console.log(`🧹 Cleaning up expired session: ${sessionId}`);
      sessions.delete(sessionId);
    }
  }
}

export function getIO(): Server {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}
