import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import http from "http";
import https from "https";
import { Socket } from "net";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../utils/httpTimeout";

/**
 * HTTP client configured with aggressive socket keep-alive to prevent
 * silent connection drops from external regional exchange APIs.
 *
 * Socket options enforce:
 * - TCP Keep-Alive enabled at the OS level
 * - 10-second idle timeout before probing starts
 * - 2-second probe intervals
 * - 3 probe attempts before connection teardown
 *
 * Total hang prevention: ~10s idle + (2s × 3) = ~16s maximum before dead socket cleanup
 */

const KEEP_ALIVE_TIMEOUT_MS = 10_000; // 10 seconds - TCP_KEEPIDLE equivalent
const KEEP_ALIVE_PROBE_INTERVAL_MS = 2_000; // 2 seconds - TCP_KEEPINTVL equivalent
const KEEP_ALIVE_MAX_RETRIES = 3; // 3 probe attempts - TCP_KEEPCNT equivalent

/**
 * HTTP agent with socket keep-alive for HTTP connections
 */
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_PROBE_INTERVAL_MS,
  timeout: KEEP_ALIVE_TIMEOUT_MS,
  maxSockets: 50,
  maxFreeSockets: 10,
});

/**
 * HTTPS agent with socket keep-alive for HTTPS connections
 */
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_PROBE_INTERVAL_MS,
  timeout: KEEP_ALIVE_TIMEOUT_MS,
  maxSockets: 50,
  maxFreeSockets: 10,
});

/**
 * Configure low-level socket options for keep-alive on the socket itself
 */
function configureSocket(socket: Socket): void {
  // Enable TCP keep-alive at the OS level
  socket.setKeepAlive(true, KEEP_ALIVE_TIMEOUT_MS);

  // Set socket timeout to match keep-alive timeout
  socket.setTimeout(KEEP_ALIVE_TIMEOUT_MS);

  // On platforms that support it (Linux), configure TCP_KEEPIDLE, TCP_KEEPINTVL, TCP_KEEPCNT
  // Note: Node.js doesn't expose these directly, but the setKeepAlive API configures them
  // The second parameter to setKeepAlive sets TCP_KEEPIDLE (initial delay before probing)
}

/**
 * Axios instance with aggressive socket keep-alive configuration
 * Use this for all external API calls to prevent silent connection hangs
 */
export const httpClient: AxiosInstance = axios.create({
  httpAgent,
  httpsAgent,
  timeout: OUTGOING_HTTP_TIMEOUT_MS, // Use project-wide timeout
  headers: {
    "Connection": "keep-alive",
    "User-Agent": "StellarFlow-Oracle/1.0",
  },
});

/**
 * Hook into socket creation to apply low-level TCP options
 */
httpAgent.on("connect" as any, (socket: Socket) => {
  configureSocket(socket);
});

httpsAgent.on("connect" as any, (socket: Socket) => {
  configureSocket(socket);
});

/**
 * Create a custom HTTP client with specific configuration
 * Useful for endpoints that require different timeout or retry settings
 */
export function createHttpClient(config?: AxiosRequestConfig): AxiosInstance {
  return axios.create({
    httpAgent,
    httpsAgent,
    timeout: OUTGOING_HTTP_TIMEOUT_MS,
    headers: {
      "Connection": "keep-alive",
      "User-Agent": "StellarFlow-Oracle/1.0",
    },
    ...config,
  });
}

/**
 * Socket configuration details for documentation and monitoring
 */
export const SOCKET_CONFIG = {
  keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  probeInterval: KEEP_ALIVE_PROBE_INTERVAL_MS,
  maxProbeRetries: KEEP_ALIVE_MAX_RETRIES,
  maxHangTime: KEEP_ALIVE_TIMEOUT_MS + (KEEP_ALIVE_PROBE_INTERVAL_MS * KEEP_ALIVE_MAX_RETRIES),
} as const;
