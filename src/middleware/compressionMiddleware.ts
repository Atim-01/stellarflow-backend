import type { Request, Response, NextFunction, RequestHandler } from "express";
import zlib from "node:zlib";

/**
 * Dynamic API Payload Compression Middleware for StellarFlow Backend.
 *
 * Implements Brotli (br) and Gzip (gzip) compression for HTTP REST API responses
 * to optimize bandwidth efficiency and network latency.
 *
 * Features:
 * - Dynamic Accept-Encoding header negotiation with quality weight (q-factor) support.
 * - Prioritizes Brotli (br) over Gzip (gzip) when quality is equal due to superior compression ratios.
 * - Configurable payload size threshold (defaults to 1 KB / 1024 bytes).
 * - Automatic MIME-type compressibility filtering (JSON, text, XML, SVG, JS, etc.).
 * - Honors 'x-no-compression' and 'Cache-Control: no-transform' bypass directives.
 * - Proper HTTP header management: 'Vary: Accept-Encoding', 'Content-Encoding', weak ETags (RFC 7232).
 */

export type SupportedEncoding = "br" | "gzip" | "deflate";

export interface CompressionOptions {
  /**
   * Minimum response body size in bytes to trigger compression.
   * Responses with size <= threshold remain uncompressed.
   * @default 1024 (1 KB)
   */
  threshold?: number;

  /**
   * Custom filter function to determine if a request/response is eligible for compression.
   */
  filter?: (req: Request, res: Response) => boolean;

  /**
   * Preferred encoding algorithm when client accepts multiple with equal quality.
   * @default "br"
   */
  prefer?: "br" | "gzip";

  /**
   * Brotli compression options.
   */
  brotliOptions?: zlib.BrotliOptions;

  /**
   * Zlib / Gzip compression options.
   */
  zlibOptions?: zlib.ZlibOptions;
}

export const DEFAULT_COMPRESSION_THRESHOLD = 1024; // 1 KB

/**
 * Regex for matching compressible MIME types.
 */
const COMPRESSIBLE_TYPES_REGEX =
  /^(?:text\/*|application\/(?:json|javascript|xml|xhtml\+xml|vnd\.api\+json|ld\+json)|image\/svg\+xml)/i;

/**
 * Parses the 'Accept-Encoding' HTTP header and negotiates the best supported encoding algorithm.
 * Handles quality factors (e.g. 'gzip;q=0.8, br;q=1.0').
 *
 * @param acceptEncodingHeader Raw Accept-Encoding header value
 * @param prefer Default preferred encoding ('br' or 'gzip')
 * @returns Best supported encoding ('br', 'gzip', 'deflate') or null if no compression
 */
export function negotiateEncoding(
  acceptEncodingHeader: string | undefined,
  prefer: "br" | "gzip" = "br",
): SupportedEncoding | null {
  if (!acceptEncodingHeader || typeof acceptEncodingHeader !== "string") {
    return null;
  }

  const header = acceptEncodingHeader.trim();
  if (!header) {
    return null;
  }

  // Parse accepted encodings with quality weights
  const parsedEncodings: { encoding: string; q: number }[] = [];
  const parts = header.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const [enc, ...params] = trimmed.split(";");
    const encodingName = enc.trim().toLowerCase();
    let q = 1.0;

    for (const param of params) {
      const match = param.trim().match(/^q\s*=\s*([0-9.]+)/i);
      if (match) {
        const parsedQ = parseFloat(match[1]);
        if (!isNaN(parsedQ)) {
          q = Math.max(0, Math.min(1, parsedQ));
        }
      }
    }

    parsedEncodings.push({ encoding: encodingName, q });
  }

  // Check if identity is explicitly forbidden (q=0)
  const identitySpec = parsedEncodings.find((e) => e.encoding === "identity");
  const starSpec = parsedEncodings.find((e) => e.encoding === "*");

  // Build candidate weights
  const getWeight = (encoding: SupportedEncoding): number => {
    const specific = parsedEncodings.find((e) => e.encoding === encoding);
    if (specific !== undefined) {
      return specific.q;
    }
    if (starSpec !== undefined) {
      return starSpec.q;
    }
    return 0;
  };

  const brWeight = getWeight("br");
  const gzipWeight = getWeight("gzip");
  const deflateWeight = getWeight("deflate");

  // If all supported encodings have 0 weight, no compression is allowed
  if (brWeight <= 0 && gzipWeight <= 0 && deflateWeight <= 0) {
    return null;
  }

  // Choose the highest quality encoding; if tied, respect preference (default: br > gzip > deflate)
  if (prefer === "br") {
    if (brWeight > 0 && brWeight >= gzipWeight && brWeight >= deflateWeight) {
      return "br";
    }
    if (gzipWeight > 0 && gzipWeight >= deflateWeight) {
      return "gzip";
    }
    if (deflateWeight > 0) {
      return "deflate";
    }
  } else {
    if (gzipWeight > 0 && gzipWeight >= brWeight && gzipWeight >= deflateWeight) {
      return "gzip";
    }
    if (brWeight > 0 && brWeight >= deflateWeight) {
      return "br";
    }
    if (deflateWeight > 0) {
      return "deflate";
    }
  }

  return null;
}

/**
 * Checks whether a response is eligible for compression.
 */
export function defaultCompressibleFilter(req: Request, res: Response): boolean {
  // Never compress HEAD requests
  if (req.method === "HEAD") {
    return false;
  }

  // Skip no-content status codes
  const statusCode = res.statusCode;
  if (statusCode === 204 || statusCode === 205 || statusCode === 304) {
    return false;
  }

  // Honor client no-compression header
  if (req.headers["x-no-compression"]) {
    return false;
  }

  // Honor Cache-Control: no-transform
  const cacheControl = res.getHeader("Cache-Control");
  if (
    typeof cacheControl === "string" &&
    cacheControl.toLowerCase().includes("no-transform")
  ) {
    return false;
  }

  // If response is already encoded, skip
  if (res.getHeader("Content-Encoding")) {
    return false;
  }

  // Check Content-Type
  const contentType = res.getHeader("Content-Type");
  if (typeof contentType === "string") {
    const baseType = contentType.split(";")[0].trim().toLowerCase();
    return COMPRESSIBLE_TYPES_REGEX.test(baseType);
  }

  // If no content-type is set yet, assume compressible for JSON/REST endpoints by default
  return true;
}

/**
 * Helper to safely append a token to the Vary header.
 */
export function appendVary(res: Response, field: string): void {
  const existing = res.getHeader("Vary");
  if (!existing) {
    res.setHeader("Vary", field);
    return;
  }

  let varyString = Array.isArray(existing) ? existing.join(", ") : String(existing);
  const fields = varyString.split(",").map((f) => f.trim().toLowerCase());

  if (!fields.includes(field.toLowerCase()) && !fields.includes("*")) {
    res.setHeader("Vary", `${varyString}, ${field}`);
  }
}

/**
 * Converts a strong ETag to a weak ETag according to RFC 7232 when content encoding is modified.
 */
function convertToWeakEtag(etag: unknown): string | undefined {
  if (typeof etag !== "string" || !etag) return undefined;
  if (etag.startsWith("W/")) return etag;
  return `W/${etag}`;
}

/**
 * Synchronously or asynchronously compresses a buffer with the specified encoding.
 */
export function compressBuffer(
  buffer: Buffer,
  encoding: SupportedEncoding,
  options?: CompressionOptions,
): Buffer {
  if (encoding === "br") {
    const brotliParams = options?.brotliOptions?.params || {
      // Quality 4 provides optimal dynamic HTTP compression speed and >70% ratio
      [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
    };
    return zlib.brotliCompressSync(buffer, {
      ...options?.brotliOptions,
      params: brotliParams,
    });
  }

  if (encoding === "gzip") {
    const level =
      options?.zlibOptions?.level ?? zlib.constants.Z_DEFAULT_COMPRESSION;
    return zlib.gzipSync(buffer, {
      ...options?.zlibOptions,
      level,
    });
  }

  if (encoding === "deflate") {
    return zlib.deflateSync(buffer, options?.zlibOptions);
  }

  return buffer;
}

/**
 * Creates a dynamic payload compression middleware for Express.
 *
 * @param options Compression configuration options
 */
export function compressionMiddleware(
  options: CompressionOptions = {},
): RequestHandler {
  const threshold = options.threshold ?? DEFAULT_COMPRESSION_THRESHOLD;
  const filter = options.filter ?? defaultCompressibleFilter;
  const prefer = options.prefer ?? "br";

  return function compressionHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // Check if client supports any accepted compression encoding
    const acceptEncoding = req.headers["accept-encoding"] as string | undefined;
    const selectedEncoding = negotiateEncoding(acceptEncoding, prefer);

    // If client does not accept compression or only accepts uncompressed
    if (!selectedEncoding) {
      return next();
    }

    // Always add Vary: Accept-Encoding so caches differentiate responses
    appendVary(res, "Accept-Encoding");

    // Preserve original write and end functions
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    let chunks: Buffer[] = [];
    let totalLength = 0;
    let isEnded = false;
    let isStreamingCompressing = false;
    let compressionStream: zlib.BrotliCompress | zlib.Gzip | zlib.Deflate | null =
      null;

    /**
     * Initializes streaming compression if threshold is exceeded during streaming writes.
     */
    function initStreamingCompression(): void {
      if (isStreamingCompressing) return;
      isStreamingCompressing = true;

      // Remove existing Content-Length since stream length is chunked/compressed
      res.removeHeader("Content-Length");
      res.setHeader("Content-Encoding", selectedEncoding!);

      const currentEtag = res.getHeader("ETag");
      if (currentEtag) {
        const weak = convertToWeakEtag(currentEtag);
        if (weak) res.setHeader("ETag", weak);
      }

      if (selectedEncoding === "br") {
        compressionStream = zlib.createBrotliCompress({
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
          },
          ...options.brotliOptions,
        });
      } else if (selectedEncoding === "gzip") {
        compressionStream = zlib.createGzip({
          level: zlib.constants.Z_DEFAULT_COMPRESSION,
          ...options.zlibOptions,
        });
      } else {
        compressionStream = zlib.createDeflate(options.zlibOptions);
      }

      compressionStream.on("data", (chunk: Buffer) => {
        originalWrite(chunk);
      });

      compressionStream.on("end", () => {
        originalEnd();
      });

      // Flush previously buffered chunks through the compression stream
      if (chunks.length > 0) {
        for (const chunk of chunks) {
          compressionStream.write(chunk);
        }
        chunks = [];
      }
    }

    // Intercept res.write
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.write = function (chunk: any, encodingOrCb?: any, cb?: any): boolean {
      if (isEnded) {
        return false;
      }

      // Check compressibility
      if (!filter(req, res)) {
        return originalWrite(chunk, encodingOrCb, cb);
      }

      if (!chunk) {
        return true;
      }

      const bufferChunk = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(
            chunk,
            typeof encodingOrCb === "string" ? encodingOrCb : "utf8",
          );

      if (isStreamingCompressing && compressionStream) {
        return compressionStream.write(bufferChunk, cb);
      }

      chunks.push(bufferChunk);
      totalLength += bufferChunk.length;

      // If buffered chunks exceed threshold, initiate streaming compression
      if (totalLength > threshold) {
        initStreamingCompression();
      }

      if (typeof encodingOrCb === "function") {
        encodingOrCb();
      } else if (typeof cb === "function") {
        cb();
      }

      return true;
    } as any;

    // Intercept res.end
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.end = function (chunk?: any, encodingOrCb?: any, cb?: any): Response {
      if (isEnded) {
        return res;
      }
      isEnded = true;

      // Normalize callback
      const callback =
        typeof encodingOrCb === "function"
          ? encodingOrCb
          : typeof cb === "function"
            ? cb
            : undefined;
      const encoding = typeof encodingOrCb === "string" ? encodingOrCb : "utf8";

      // If not eligible for compression, flush uncompressed
      if (!filter(req, res)) {
        if (chunks.length > 0) {
          for (const c of chunks) {
            originalWrite(c);
          }
          chunks = [];
        }
        return originalEnd(chunk, encoding, callback);
      }

      if (chunk) {
        const bufferChunk = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, encoding);
        if (isStreamingCompressing && compressionStream) {
          compressionStream.end(bufferChunk, callback);
          return res;
        }
        chunks.push(bufferChunk);
        totalLength += bufferChunk.length;
      }

      // If streaming compression is active, end stream
      if (isStreamingCompressing && compressionStream) {
        compressionStream.end(callback);
        return res;
      }

      // Single-payload or buffered response: evaluate threshold
      if (totalLength <= threshold) {
        // Size <= threshold: Do NOT compress. Send raw buffer(s).
        const payloadBuffer =
          chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalLength);
        chunks = [];
        return originalEnd(payloadBuffer, callback);
      }

      // Size > threshold: Compress payload
      try {
        const payloadBuffer =
          chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalLength);
        chunks = [];

        const compressed = compressBuffer(
          payloadBuffer,
          selectedEncoding!,
          options,
        );

        res.setHeader("Content-Encoding", selectedEncoding!);
        res.setHeader("Content-Length", compressed.length);

        const currentEtag = res.getHeader("ETag");
        if (currentEtag) {
          const weak = convertToWeakEtag(currentEtag);
          if (weak) res.setHeader("ETag", weak);
        }

        return originalEnd(compressed, callback);
      } catch (err) {
        // Fallback to uncompressed in case of compression error
        const payloadBuffer =
          chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalLength);
        chunks = [];
        return originalEnd(payloadBuffer, callback);
      }
    } as any;

    next();
  };
}

export default compressionMiddleware;
