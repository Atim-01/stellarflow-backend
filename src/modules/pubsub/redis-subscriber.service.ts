import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { createClient, RedisClientType } from "redis";
import { CHANNELS } from "./constants/channels";
import { PriceCacheService } from "../cache/price-cache.service";
import { unpack } from "../serialization/binaryPack";

export interface MarketStreamEvent {
  type: "price" | "volume" | "orderbook";
  pairs: string[];
  data: Record<string, any>;
  ts: number;
}

export type MarketStreamListener = (event: MarketStreamEvent) => void;

@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);
  private subscriber: RedisClientType;
  private readonly listeners: Set<MarketStreamListener> = new Set();
  private readonly pairSubscribers: Map<string, Set<MarketStreamListener>> =
    new Map();
  private readonly pairRefs: Map<string, number> = new Map();

  constructor(private readonly priceCache: PriceCacheService) {
    this.subscriber = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });
  }

  async onModuleInit() {
    const isCiOrTest =
      process.env.NODE_ENV === "test" ||
      process.env.CI?.toLowerCase() === "true" ||
      process.env.GITHUB_ACTIONS?.toLowerCase() === "true";
    if (isCiOrTest) {
      return;
    }

    await this.subscriber.connect();

    await this.subscriber.subscribe(CHANNELS.PRICE_UPDATES, message => {
      this.dispatch("price", message);
    });

    await this.subscriber.subscribe(CHANNELS.VOLUME_UPDATES, message => {
      this.dispatch("volume", message);
    });

    await this.subscriber.subscribe(CHANNELS.ORDERBOOK_UPDATES, message => {
      this.dispatch("orderbook", message);
    });

    this.logger.log("Redis Subscriber listening...");
  }

  private dispatch(type: MarketStreamEvent["type"], message: unknown) {
    try {
      const payload =
        typeof message === "string" ? Buffer.from(message, "utf-8") : message;
      const data = unpack(payload as Buffer);
      this.handleUpdate(type, data);
    } catch (err) {
      this.logger.error("Invalid message received", err as Error);
    }
  }

  private handleUpdate(type: MarketStreamEvent["type"], data: any) {
    const symbol = data.symbol || data.pair;
    if (!symbol) {
      return;
    }

    if (type === "price") {
      this.priceCache.set(symbol, data.price);
      this.logger.debug(`Synced price: ${symbol} = ${data.price}`);
    }

    const event: MarketStreamEvent = {
      type,
      pairs: [symbol],
      data,
      ts: Date.now(),
    };

    this.emit(event);
  }

  private emit(event: MarketStreamEvent) {
    for (const listener of this.listeners) {
      this.safeInvoke(listener, event);
    }

    for (const pair of event.pairs) {
      const pairListeners = this.pairSubscribers.get(pair);
      if (!pairListeners) {
        continue;
      }
      for (const listener of pairListeners) {
        this.safeInvoke(listener, event);
      }
    }
  }

  private safeInvoke(listener: MarketStreamListener, event: MarketStreamEvent) {
    try {
      listener(event);
    } catch (err) {
      this.logger.error("Market stream listener failed", err as Error);
    }
  }

  addListener(listener: MarketStreamListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addPairListener(pair: string, listener: MarketStreamListener): () => void {
    let set = this.pairSubscribers.get(pair);
    if (!set) {
      set = new Set();
      this.pairSubscribers.set(pair, set);
    }
    set.add(listener);

    const refs = (this.pairRefs.get(pair) || 0) + 1;
    this.pairRefs.set(pair, refs);

    return () => {
      const current = this.pairSubscribers.get(pair);
      if (current) {
        current.delete(listener);
        if (current.size === 0) {
          this.pairSubscribers.delete(pair);
        }
      }
      const remaining = (this.pairRefs.get(pair) || 1) - 1;
      if (remaining <= 0) {
        this.pairRefs.delete(pair);
      } else {
        this.pairRefs.set(pair, remaining);
      }
    };
  }

  getActivePairs(): string[] {
    return Array.from(this.pairSubscribers.keys());
  }

  getListenerCount(): number {
    return this.listeners.size;
  }

  async onModuleDestroy() {
    this.listeners.clear();
    this.pairSubscribers.clear();
    this.pairRefs.clear();
    if (this.subscriber.isOpen) {
      await this.subscriber.quit();
    }
  }
}
