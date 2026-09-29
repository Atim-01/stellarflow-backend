/**
 * Prometheus metrics used across services.
 * Re-exported from the central middleware/metrics module so every
 * service can import from "../metrics" without circular dependencies.
 */
import { Counter, Histogram, Gauge } from "prom-client";

export const successfulSubmissions = new Counter({
  name: "stellar_submissions_success_total",
  help: "Total number of successful Stellar price submissions",
  labelNames: ["asset"] as const,
});

export const failedSubmissions = new Counter({
  name: "stellar_submissions_failed_total",
  help: "Total number of failed Stellar price submissions",
  labelNames: ["asset", "reason"] as const,
});

export const gasUsagePerAsset = new Histogram({
  name: "stellar_gas_stroops",
  help: "Transaction fee in stroops per asset",
  labelNames: ["asset"] as const,
  buckets: [100, 500, 1000, 5000, 10000, 50000],
});

export const submissionDuration = new Histogram({
  name: "stellar_submission_duration_seconds",
  help: "Duration of Stellar submission operations in seconds",
  labelNames: ["asset"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

export const assetVolatility = new Gauge({
  name: "stellar_asset_volatility_24h",
  help: "24-hour rolling volatility index for an asset",
  labelNames: ["asset"] as const,
});

// --- Market stream metrics ---

export const marketStreamConnections = new Gauge({
  name: "stellar_market_stream_connections_active",
  help: "Number of currently active market-stream WebSocket connections",
  labelNames: ["transport"] as const,
});

export const marketStreamConnectionsTotal = new Counter({
  name: "stellar_market_stream_connections_total",
  help: "Total number of market-stream WebSocket connections accepted",
  labelNames: ["transport"] as const,
});

export const marketStreamClientMemoryBytes = new Gauge({
  name: "stellar_market_stream_client_memory_bytes",
  help: "Estimated memory overhead in bytes per market-stream client connection",
  labelNames: ["transport"] as const,
});

export const marketStreamClientMemoryTotalBytes = new Gauge({
  name: "stellar_market_stream_client_memory_total_bytes",
  help: "Total estimated memory overhead in bytes for all market-stream client connections",
  labelNames: ["transport"] as const,
});

export const marketStreamMessagesSent = new Counter( {
  name: "stellar_market_stream_messages_sent_total",
  help: "Total number of market-stream events sent to clients",
  labelNames: ["transport", "kind"] as const,
});

export const marketStreamSubscriptions = new Gauge({
  name: "stellar_market_stream_subscriptions_active",
  help: "Number of active pair subscriptions across market-stream clients",
  labelNames: ["transport"] as const,
});

export const marketStreamBroadcastDuration = new Histogram({
  name: "stellar_market_stream_broadcast_duration_seconds",
  help: "Duration of broadcasting a market update to all subscribed clients",
  labelNames: ["transport", "kind"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});
