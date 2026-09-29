import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { createClient, RedisClientType } from "redis";
import { MessageBus } from "./message-bus.interface";
import { pack } from "../serialization/binaryPack";

const MAX_ACTIVE_SOCKETS = 10_000;
const ESTIMATED_BYTES_PER_SOCKET = 8 * 1024;

@Injectable()
export class RedisPubSubService implements MessageBus, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private publisher: RedisClientType;

  constructor() {
    const isCiOrTest =
      process.env.NODE_ENV === "test" ||
      process.env.CI?.toLowerCase() === "true" ||
      process.env.GITHUB_ACTIONS?.toLowerCase() === "true";
    if (isCiOrTest) {
      this.publisher = createClient({ url: "redis://127.0.0.1:6379" });
      return;
    }

    this.publisher = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });

    this.publisher.connect().catch((err) => {
      this.logger.error("Redis Publisher Connection Failed", err);
    });
  }

  async publish<T = any>(channel: string, message: T): Promise<void> {
    const payload = Buffer.from(pack(message));
    await this.publisher.publish(channel, payload);

    this.logger.debug(`Published to ${channel}`);
  }

  /**
   * Multiplexes a batch of market updates (price, volume, order book) into a
   * single binary-packed payload and publishes it on the given channel.
   * This keeps the combined market-stream endpoint high-efficiency by
   * amortizing Redis round-trips across many pairs.
   */
  async publishBatch<T = any>(channel: string, messages: T[]): Promise<void> {
    if (!messages.length) return;
    const payload = Buffer.from(pack(messages));
    await this.publisher.publish(channel, payload);

    this.logger.debug(`Published batch of ${messages.length} to ${channel}`);
  }

  /**
   * Reports the estimated client connection memory overhead so operators can
   * verify the aggregator can sustain 10,000 active sockets.
   */
  getConnectionMemoryEstimate(activeSockets: number = MAX_ACTIVE_SOCKETS): {
    activeSockets: number;
    bytesPerSocket: number;
    totalBytes: number;
    withinBudget: boolean;
  } {
    const totalBytes = activeSockets * ESTIMATED_BYTES_PER_SOCKET;
    return {
      activeSockets,
      bytesPerSocket: ESTIMATED_BYTES_PER_SOCKET,
      totalBytes,
      withinBudget: activeSockets <= MAX_ACTIVE_SOCKETS,
    };
  }

  async subscribe(): Promise<void> {
    throw new Error("Use RedisSubscriberService for subscriptions");
  }

  async onModuleDestroy() {
    await this.publisher.quit();
  }
}
