import { decode, encode } from "@msgpack/msgpack";

/**
 * Market stream event kinds multiplexed over a single WebSocket endpoint.
 */
export type MarketStreamEventType = "price" | "volume" | "orderbook";

export interface MarketStreamEvent<T = unknown> {
  /** Event kind discriminator. */
  t: MarketStreamEventType;
  /** Trading pair, in canonical form (e.g. "USDC-XLM"). */
  p: string;
  /** Exchange timestamp in milliseconds. */
  ts: number;
  /** Event payload. */
  d: T;
}

/**
 * Pack a value into MsgPack bytes.
 */
export function pack<T = unknown>(data: T): Uint8Array {
  return encode(data);
}

/**
 * Unpack MsgPack bytes or a MsgPack string back into a value.
 */
export function unpack<T = unknown>(payload: Uint8Array | Buffer | string): T {
  if (typeof payload === "string") {
    return decode(Buffer.from(payload, "utf-8")) as T;
  }

  return decode(payload) as T;
}

/**
 * Pack a multiplexed market stream event into MsgPack bytes.
 */
export function packMarketEvent<T = unknown>(
  event: MarketStreamEvent<T>,
): Uint8Array {
  return pack(event);
}

/**
 * Unpack a multiplexed market stream event from MsgPack bytes or a string.
 */
export function unpackMarketEvent<T = unknown>(
  payload: Uint8Array | Buffer | string,
): MarketStreamEvent<T> {
  return unpack<MarketStreamEvent<T>>(payload);
}
