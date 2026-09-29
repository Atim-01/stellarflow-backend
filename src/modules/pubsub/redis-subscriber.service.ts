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
  timestamp: number;
  data: Record<string, any>;
}

@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);
  private subscriber: RedisClientType;
  private readonly listeners = new Set<(event: MarketStreamEvent) => void>()>;

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

    await this.subscriber.subscribe(CHANNELS.PRICE_UPDATES, (message) => {
      this.handleMessage("price", message);
    });

    await this.subscriber.subscribe(CHANNELS.VOLUME_UPDATES, (message) => {
      this.handleMessage("volume", message);
    });

    await this.subscriber.subscribe(CHANNELS.ORDERBOOK_UPDATES, (message) => {
      this.handleMessage("orderbook", message);
    });

    this.logger.log("Redis Subscriber listening...");
  }

  public on(event: MarketStreamEvent): () => void {
    const listener = (e: MarketStreamEvent) => event;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public addListener(listener: (event: MarketStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private handleMessage(type: MarketStreamEvent["type"], message: unknown) {
    try {
      const payload =
        typeof message === "string" ? Buffer.from(message, "utf-8") : message;
      const data = unpack(payload as Buffer);
      this.dispatch(type, data);
    } catch (err) {
      this.logger.error("Invalid message received", err);
    }
  }

  private dispatch(type: MarketStreamEvent["type"], data: any) {
    const symbol = data.symbol || data.pair || data.pairs;
    const pairs = Array.isArray(symbol) ? symbol : symbol ? [symbol] : [];

    if (type === "price" && data.symbol !== undefined) {
      this.priceCache.set(data.symbol, data.price);
      this.logger.debug(`Synced price: ${data.symbol} = ${data.price}`);
    }

    const event: MarketStreamEvent = {
      type,
      pairs,
      timestamp: data.timestamp || Date.now(),
      data,
    };

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error("Market stream listener failed", err);
      }
    }
  }

  async onModuleDestroy() {
    this.listeners.clear();
    await this.subscriber.quit();
  }
}
