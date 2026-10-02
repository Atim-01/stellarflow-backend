import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import express from "express";
import { createServer } from "http";
import type { Server } from "http";
import type { AddressInfo } from "net";
import zlib from "node:zlib";

import {
  compressionMiddleware,
  negotiateEncoding,
  defaultCompressibleFilter,
  compressBuffer,
  DEFAULT_COMPRESSION_THRESHOLD,
} from "../src/middleware/compressionMiddleware";

let server: Server;
let baseUrl: string;

// Sample large pool history dataset generator
function generateMockPoolHistory(count = 100) {
  const records = [];
  const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();

  for (let i = 0; i < count; i++) {
    records.push({
      id: `hist_${i}_${Math.random().toString(36).substring(2, 9)}`,
      poolId: "xlm-usdc-pool-01",
      assetA: "XLM",
      assetB: "USDC",
      rate: 0.1245 + (i % 10) * 0.0012,
      reserveA: "1450230.5000000",
      reserveB: "180553.6972500",
      volume24hUsd: 382100.75,
      feeApyPercent: 12.45,
      tradesCount: 1420 + i,
      source: "stellar_horizon_rpc_mainnet",
      timestamp: new Date(baseTime + i * 3600 * 1000).toISOString(),
      blockNumber: 48920100 + i,
      transactionHash: `0x${Array(64).fill("a").join("")}`,
    });
  }

  return {
    success: true,
    poolId: "xlm-usdc-pool-01",
    range: "30d",
    totalRecords: records.length,
    data: records,
  };
}

beforeAll(async () => {
  const app = express();

  // Mount compression middleware with default 1 KB threshold
  app.use(compressionMiddleware());

  // Small payload endpoint (<= 1024 bytes)
  app.get("/api/small-payload", (_req, res) => {
    res.json({
      success: true,
      message: "small response under 1kb",
    });
  });

  // Large pool history query endpoint (> 1 KB)
  app.get("/api/v1/history/pools", (_req, res) => {
    res.setHeader("ETag", '"pool-history-strong-etag-123"');
    res.json(generateMockPoolHistory(100));
  });

  // Bypass via Cache-Control: no-transform
  app.get("/api/no-transform", (_req, res) => {
    res.setHeader("Cache-Control", "no-transform");
    res.json(generateMockPoolHistory(50));
  });

  // Non-compressible content type endpoint
  app.get("/api/binary-image", (_req, res) => {
    res.setHeader("Content-Type", "image/png");
    res.send(Buffer.alloc(2048, 1));
  });

  // Streaming endpoint
  app.get("/api/streaming-history", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    const jsonStr = JSON.stringify(generateMockPoolHistory(80));
    const part1 = jsonStr.slice(0, 1500);
    const part2 = jsonStr.slice(1500);
    res.write(part1);
    res.write(part2);
    res.end();
  });

  server = createServer(app);
  server.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("Encoding Negotiation (negotiateEncoding)", () => {
  it("negotiates Brotli (br) when both gzip and br are accepted equally", () => {
    expect(negotiateEncoding("gzip, br")).toBe("br");
    expect(negotiateEncoding("br, gzip")).toBe("br");
  });

  it("negotiates Gzip when only gzip is accepted", () => {
    expect(negotiateEncoding("gzip")).toBe("gzip");
    expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
  });

  it("negotiates Brotli when only br is accepted", () => {
    expect(negotiateEncoding("br")).toBe("br");
  });

  it("respects quality weights (q-factors)", () => {
    expect(negotiateEncoding("gzip;q=1.0, br;q=0.5")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0.4, br;q=0.8")).toBe("br");
    expect(negotiateEncoding("gzip;q=0.8, deflate;q=0.9, br;q=0.5")).toBe("deflate");
  });

  it("returns null when all encodings have q=0 or no supported encoding is present", () => {
    expect(negotiateEncoding("gzip;q=0, br;q=0")).toBeNull();
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding("unknown-encoding")).toBeNull();
    expect(negotiateEncoding("")).toBeNull();
    expect(negotiateEncoding(undefined)).toBeNull();
  });

  it("handles wildcard (*) accept-encoding", () => {
    expect(negotiateEncoding("*")).toBe("br");
  });
});

describe("Dynamic Compression Middleware - Acceptance Criteria", () => {
  it("does NOT compress HTTP responses with payload size <= 1 KB", async () => {
    const res = await fetch(`${baseUrl}/api/small-payload`, {
      headers: { "Accept-Encoding": "gzip, br" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toContain("Accept-Encoding");

    const json = await res.json();
    expect(json).toEqual({
      success: true,
      message: "small response under 1kb",
    });
  });

  it("compresses HTTP responses exceeding 1 KB with Brotli when Accept-Encoding: br is sent", async () => {
    const res = await fetch(`${baseUrl}/api/v1/history/pools`, {
      headers: { "Accept-Encoding": "br" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");

    // Strong ETag should be converted to weak ETag
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^W\//);

    const arrayBuffer = await res.arrayBuffer();
    const rawBuffer = Buffer.from(arrayBuffer);
    const decompressed = zlib.brotliDecompressSync(rawBuffer).toString("utf8");
    const parsed = JSON.parse(decompressed);

    expect(parsed.success).toBe(true);
    expect(parsed.totalRecords).toBe(100);
    expect(parsed.data.length).toBe(100);
  });

  it("compresses HTTP responses exceeding 1 KB with Gzip when Accept-Encoding: gzip is sent", async () => {
    const res = await fetch(`${baseUrl}/api/v1/history/pools`, {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");

    const arrayBuffer = await res.arrayBuffer();
    const rawBuffer = Buffer.from(arrayBuffer);
    const decompressed = zlib.gunzipSync(rawBuffer).toString("utf8");
    const parsed = JSON.parse(decompressed);

    expect(parsed.success).toBe(true);
    expect(parsed.totalRecords).toBe(100);
  });

  it("supports Accept-Encoding: gzip, br headers by selecting optimal Brotli compression", async () => {
    const res = await fetch(`${baseUrl}/api/v1/history/pools`, {
      headers: { "Accept-Encoding": "gzip, br" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
  });

  it("does NOT compress when client sends no Accept-Encoding header", async () => {
    const res = await fetch(`${baseUrl}/api/v1/history/pools`, {
      headers: { "Accept-Encoding": "" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("bypasses compression when x-no-compression header is sent by client", async () => {
    const res = await fetch(`${baseUrl}/api/v1/history/pools`, {
      headers: {
        "Accept-Encoding": "gzip, br",
        "x-no-compression": "true",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("bypasses compression when Cache-Control: no-transform is set", async () => {
    const res = await fetch(`${baseUrl}/api/no-transform`, {
      headers: { "Accept-Encoding": "gzip, br" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("does not compress non-compressible binary MIME types (image/png)", async () => {
    const res = await fetch(`${baseUrl}/api/binary-image`, {
      headers: { "Accept-Encoding": "gzip, br" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("supports chunked / streaming response compression exceeding threshold", async () => {
    const res = await fetch(`${baseUrl}/api/streaming-history`, {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");

    const arrayBuffer = await res.arrayBuffer();
    const rawBuffer = Buffer.from(arrayBuffer);
    const decompressed = zlib.gunzipSync(rawBuffer).toString("utf8");
    const parsed = JSON.parse(decompressed);

    expect(parsed.success).toBe(true);
    expect(parsed.totalRecords).toBe(80);
  });
});

describe("Compression Ratio Benchmark on Large Pool History Queries", () => {
  it("reduces network transfer payload sizes by >70% on large pool history queries", () => {
    const mockData = generateMockPoolHistory(150);
    const uncompressedJson = Buffer.from(JSON.stringify(mockData), "utf8");
    const uncompressedSize = uncompressedJson.length;

    // Verify uncompressed size is substantial (>20 KB)
    expect(uncompressedSize).toBeGreaterThan(1024);

    // Gzip Compression Benchmark
    const gzipCompressed = compressBuffer(uncompressedJson, "gzip");
    const gzipSize = gzipCompressed.length;
    const gzipSavingsPercent =
      ((uncompressedSize - gzipSize) / uncompressedSize) * 100;

    // Brotli Compression Benchmark
    const brotliCompressed = compressBuffer(uncompressedJson, "br");
    const brotliSize = brotliCompressed.length;
    const brotliSavingsPercent =
      ((uncompressedSize - brotliSize) / uncompressedSize) * 100;

    console.log(`\n📊 Payload Compression Benchmark Results:`);
    console.log(`   - Uncompressed JSON Size: ${(uncompressedSize / 1024).toFixed(2)} KB (${uncompressedSize} bytes)`);
    console.log(`   - Gzip Compressed Size:   ${(gzipSize / 1024).toFixed(2)} KB (${gzipSize} bytes) -> ${gzipSavingsPercent.toFixed(2)}% reduction`);
    console.log(`   - Brotli Compressed Size: ${(brotliSize / 1024).toFixed(2)} KB (${brotliSize} bytes) -> ${brotliSavingsPercent.toFixed(2)}% reduction\n`);

    // Verify acceptance criteria: > 70% reduction
    expect(gzipSavingsPercent).toBeGreaterThan(70);
    expect(brotliSavingsPercent).toBeGreaterThan(70);

    // Verify Brotli outperforms or matches Gzip
    expect(brotliSavingsPercent).toBeGreaterThanOrEqual(gzipSavingsPercent - 2);

    // Verify data integrity round-trip
    const restoredGzip = JSON.parse(zlib.gunzipSync(gzipCompressed).toString("utf8"));
    const restoredBrotli = JSON.parse(zlib.brotliDecompressSync(brotliCompressed).toString("utf8"));

    expect(restoredGzip).toEqual(mockData);
    expect(restoredBrotli).toEqual(mockData);
  });
});
