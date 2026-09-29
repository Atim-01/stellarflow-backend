import { decode, encode } from "@msgpack/msgpack";

export type MarketStreamEventType = "price" | "volume" | "orderbook";

export interface MarketStreamEvent {
  t: MarketStreamEventType;
  p: string;
  ts: number;
  d: Unknown;
}

export interface MarketStreamBatch {
  events: MarketStreamEvent[];
}

export function pack<T = unknown>(data: T): Uint8Array {
  return encode(data);
}

export function unpack<T = unknown>(payload: Uint8Array | Buffer | string): T {
  if (typeof payload === "string") {
    return decode(Buffer.from(payload, "utf-8")) as T;
  }

  return decode(payload) as T;
}

export function packMarketStreamBatch(events: MarketStreamEvent[]): Uint8Array {
  return pack({ events });
}

export function unpackMarketStreamBatch(payload: Uint8Array | Buffer | string): MarketStreamEvent[] {
  const decoded = unpack<MarketStreamBatch>(payload);
  return Array.isArray(decoded.events) ? decoded.events : [];
}
