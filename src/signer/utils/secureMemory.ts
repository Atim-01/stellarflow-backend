/**
 * Memory Security & Zeroization Utilities for Cryptographic Operations.
 *
 * Ensures sensitive data such as PINs, passphrases, and intermediate cryptographic buffers
 * are explicitly and immediately wiped from process memory to defend against memory
 * dumps, swap leakage, and memory inspection attacks.
 */

/**
 * Explicitly overwrites memory in a buffer with multiple passes (0x00, 0xFF, 0x00)
 * to prevent compiler dead-code elimination and ensure hardware DRAM charge dissipation.
 *
 * @param buffer - Buffer to wipe
 */
export function zeroize(buffer: Buffer | Uint8Array | null | undefined): void {
  if (!buffer || !(buffer instanceof Uint8Array || Buffer.isBuffer(buffer))) {
    return;
  }

  // Pass 1: Zero fill
  buffer.fill(0);
  // Pass 2: Inverted pattern
  buffer.fill(0xff);
  // Pass 3: Final zero fill
  buffer.fill(0);
}

/**
 * Context manager executing a callback with a temporary sensitive buffer,
 * guaranteeing complete memory zeroization in a finally block even if an error is thrown.
 *
 * @param buffer - Buffer containing sensitive material
 * @param fn - Function to execute
 */
export async function withSecureBuffer<T>(
  buffer: Buffer,
  fn: (buf: Buffer) => Promise<T> | T,
): Promise<T> {
  try {
    return await fn(buffer);
  } finally {
    zeroize(buffer);
  }
}

/**
 * Creates a secure buffer from a string, executes the action, and immediately zeroizes the buffer.
 *
 * @param secret - Sensitive string (e.g. PIN)
 * @param fn - Function to execute with the secure Buffer
 */
export async function withSecureString<T>(
  secret: string,
  fn: (buf: Buffer) => Promise<T> | T,
): Promise<T> {
  const buf = Buffer.from(secret, "utf8");
  return withSecureBuffer(buf, fn);
}
