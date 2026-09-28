/**
 * Tests for GET /api/v1/remittance/history
 *
 * Covers:
 * - 401 when no JWT present
 * - successful page with no filters
 * - status / asset / date-range filter forwarding
 * - limit parameter validation
 * - invalid date rejection
 * - from > to rejection
 * - invalid status rejection
 * - cursor forwarding and nextCursor in response
 * - invalid cursor rejection
 * - service error mapped to 500
 *
 * Unit-test strategy: Prisma is mocked so no DB connection is required.
 * The route handler is extracted from the router stack and called directly,
 * matching the pattern used in the existing history.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Mock Prisma BEFORE importing the modules under test
// ---------------------------------------------------------------------------
const mockFindMany = vi.fn();

vi.mock("../src/lib/prisma", () => ({
  default: {
    remittanceTransaction: {
      findMany: mockFindMany,
    },
  },
}));

// Import after mocking
import remittanceRouter from "../src/routes/remittance";
import { encodeCursor, decodeCursor } from "../src/services/remittanceService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull the async handler function from the router stack for `GET /history`. */
function getHandler() {
  const layer = (remittanceRouter as any).stack.find(
    (l: any) => l.route?.path === "/history",
  );
  if (!layer) throw new Error("Could not find /history route in router stack");
  // The last handle in the stack is the route handler (after any middleware)
  const handles: ((...args: unknown[]) => unknown)[] = layer.route.stack.map(
    (s: { handle: (...args: unknown[]) => unknown }) => s.handle,
  );
  return handles[handles.length - 1];
}

/** Build a minimal mock Express Request. */
function makeReq(
  overrides: Partial<{
    query: Record<string, string>;
    user: { userId: number; role: string };
    headers: Record<string, string>;
  }> = {},
): Partial<Request> & { user?: { userId: number; role: string } } {
  return {
    query: overrides.query ?? {},
    user: overrides.user ?? { userId: 42, role: "VIEWER" },
    headers: overrides.headers ?? {},
  };
}

/** Build a minimal mock Express Response that captures json/status calls. */
function makeRes() {
  const res: Partial<Response> & {
    _body?: unknown;
    _status?: number;
  } = {};

  const statusFn = vi.fn().mockImplementation((code: number) => {
    res._status = code;
    return res;
  });

  const jsonFn = vi.fn().mockImplementation((body: unknown) => {
    res._body = body;
    return res;
  });

  res.status = statusFn;
  res.json = jsonFn;

  return res as typeof res & { status: typeof statusFn; json: typeof jsonFn };
}

/** Build a fake RemittanceTransaction DB row. */
function makeRow(
  overrides: Partial<{
    id: string;
    userId: string;
    asset: string;
    senderCurrency: string;
    receiverCurrency: string;
    amount: number;
    outputAmount: number;
    fee: number;
    rate: number;
    status: string;
    provider: string | null;
    stellarTxHash: string | null;
    reference: string | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
) {
  return {
    id: overrides.id ?? "uuid-1",
    userId: overrides.userId ?? "42",
    asset: overrides.asset ?? "XLM",
    senderCurrency: overrides.senderCurrency ?? "NGN",
    receiverCurrency: overrides.receiverCurrency ?? "KES",
    amount: overrides.amount ?? 50000,
    outputAmount: overrides.outputAmount ?? 9850,
    fee: overrides.fee ?? 150,
    rate: overrides.rate ?? 0.197,
    status: overrides.status ?? "COMPLETED",
    provider: overrides.provider ?? "StellarDEX",
    stellarTxHash: overrides.stellarTxHash ?? null,
    reference: overrides.reference ?? null,
    errorMessage: overrides.errorMessage ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-08-01T10:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-08-01T10:01:00Z"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/remittance/history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Authentication --------------------------------------------------------

  it("returns 401 when no user is attached to the request", async () => {
    const handler = getHandler();
    const req = makeReq({ user: undefined as any });
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(401);
    expect((res._body as any).success).toBe(false);
  });

  // ---- Happy path: no filters ------------------------------------------------

  it("returns an empty data array when no transactions exist", async () => {
    mockFindMany.mockResolvedValue([]);

    const handler = getHandler();
    const req = makeReq();
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: [],
        nextCursor: null,
        limit: 20,
      }),
    );
  });

  it("returns transactions serialised to plain numbers/strings", async () => {
    const row = makeRow();
    mockFindMany.mockResolvedValue([row]);

    const handler = getHandler();
    const req = makeReq();
    const res = makeRes();

    await handler(req as Request, res as Response);

    const body = res._body as any;
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);

    const tx = body.data[0];
    expect(tx.id).toBe(row.id);
    expect(tx.userId).toBe(row.userId);
    expect(tx.asset).toBe(row.asset);
    expect(typeof tx.amount).toBe("number");
    expect(tx.createdAt).toBe(row.createdAt.toISOString());
  });

  // ---- Filter forwarding -------------------------------------------------------

  it("passes status filter through to Prisma", async () => {
    mockFindMany.mockResolvedValue([]);

    const handler = getHandler();
    const req = makeReq({ query: { status: "COMPLETED" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    const callArg = mockFindMany.mock.calls[0][0];
    // The where object is either top-level or nested under AND
    const where = callArg.where?.AND?.[0] ?? callArg.where;
    expect(where.status).toBe("COMPLETED");
  });

  it("uppercases the status filter before querying", async () => {
    mockFindMany.mockResolvedValue([]);

    const handler = getHandler();
    const req = makeReq({ query: { status: "completed" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    const callArg = mockFindMany.mock.calls[0][0];
    const where = callArg.where?.AND?.[0] ?? callArg.where;
    expect(where.status).toBe("COMPLETED");
  });

  it("passes asset filter (uppercased) through to Prisma", async () => {
    mockFindMany.mockResolvedValue([]);

    const handler = getHandler();
    const req = makeReq({ query: { asset: "xlm" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    const callArg = mockFindMany.mock.calls[0][0];
    const where = callArg.where?.AND?.[0] ?? callArg.where;
    expect(where.asset).toBe("XLM");
  });

  it("passes from/to date range through to Prisma", async () => {
    mockFindMany.mockResolvedValue([]);

    const from = "2026-01-01T00:00:00Z";
    const to = "2026-06-30T23:59:59Z";

    const handler = getHandler();
    const req = makeReq({ query: { from, to } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    const callArg = mockFindMany.mock.calls[0][0];
    const where = callArg.where?.AND?.[0] ?? callArg.where;
    expect(where.createdAt?.gte?.toISOString()).toBe(
      new Date(from).toISOString(),
    );
    expect(where.createdAt?.lte?.toISOString()).toBe(
      new Date(to).toISOString(),
    );
  });

  it("passes limit through (default 20)", async () => {
    mockFindMany.mockResolvedValue([]);

    const handler = getHandler();
    const req = makeReq();
    const res = makeRes();

    await handler(req as Request, res as Response);

    const callArg = mockFindMany.mock.calls[0][0];
    // Service fetches limit + 1
    expect(callArg.take).toBe(21);
  });

  it("respects a custom limit param", async () => {
    mockFindMany.mockResolvedValue([]);

    const handler = getHandler();
    const req = makeReq({ query: { limit: "5" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    const callArg = mockFindMany.mock.calls[0][0];
    expect(callArg.take).toBe(6); // 5 + 1
    expect((res._body as any).limit).toBe(5);
  });

  // ---- Pagination / cursor ---------------------------------------------------

  it("returns nextCursor when more rows exist beyond the page", async () => {
    // Return 21 rows when limit is 20 → hasMore = true
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeRow({
        id: `uuid-${i + 1}`,
        createdAt: new Date(Date.now() - i * 60_000),
        updatedAt: new Date(Date.now() - i * 60_000),
      }),
    );
    mockFindMany.mockResolvedValue(rows);

    const handler = getHandler();
    const req = makeReq();
    const res = makeRes();

    await handler(req as Request, res as Response);

    const body = res._body as any;
    expect(body.data).toHaveLength(20);
    expect(typeof body.nextCursor).toBe("string");

    // The cursor must decode to the last row of the page (index 19)
    const decoded = decodeCursor(body.nextCursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(rows[19].id);
  });

  it("returns nextCursor = null on the last page", async () => {
    mockFindMany.mockResolvedValue([makeRow()]);

    const handler = getHandler();
    const req = makeReq();
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect((res._body as any).nextCursor).toBeNull();
  });

  it("forwards a valid cursor to the Prisma query", async () => {
    const cursor = encodeCursor({
      createdAt: "2026-08-01T10:00:00.000Z",
      id: "uuid-99",
    });

    mockFindMany.mockResolvedValue([]);

    const handler = getHandler();
    const req = makeReq({ query: { cursor } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    // The query must include an OR clause from the cursor condition
    const callArg = mockFindMany.mock.calls[0][0];
    const outerWhere = callArg.where;
    // When a cursor is present the finalWhere wraps everything in AND
    expect(outerWhere.AND).toBeDefined();
    const cursorWhere = outerWhere.AND[1];
    expect(cursorWhere.OR).toBeDefined();
    expect(cursorWhere.OR).toHaveLength(2);
  });

  it("returns 400 for a malformed cursor", async () => {
    const handler = getHandler();
    const req = makeReq({ query: { cursor: "not-valid-base64url!!" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res._body as any).success).toBe(false);
  });

  // ---- Validation errors ------------------------------------------------------

  it("returns 400 for an invalid status value", async () => {
    const handler = getHandler();
    const req = makeReq({ query: { status: "UNKNOWN_STATUS" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res._body as any).success).toBe(false);
  });

  it("returns 400 when 'from' is not a valid date", async () => {
    const handler = getHandler();
    const req = makeReq({ query: { from: "not-a-date" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res._body as any).success).toBe(false);
  });

  it("returns 400 when 'to' is not a valid date", async () => {
    const handler = getHandler();
    const req = makeReq({ query: { to: "garbage" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res._body as any).success).toBe(false);
  });

  it("returns 400 when 'from' is after 'to'", async () => {
    const handler = getHandler();
    const req = makeReq({
      query: {
        from: "2026-12-31T00:00:00Z",
        to: "2026-01-01T00:00:00Z",
      },
    });
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res._body as any).success).toBe(false);
  });

  it("returns 400 when limit is out of range (0)", async () => {
    const handler = getHandler();
    const req = makeReq({ query: { limit: "0" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 400 when limit is out of range (> 100)", async () => {
    const handler = getHandler();
    const req = makeReq({ query: { limit: "101" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 400 when limit is not numeric", async () => {
    const handler = getHandler();
    const req = makeReq({ query: { limit: "abc" } });
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  // ---- Service / DB errors ---------------------------------------------------

  it("returns 500 when Prisma throws an unexpected error", async () => {
    mockFindMany.mockRejectedValue(new Error("DB connection lost"));

    const handler = getHandler();
    const req = makeReq();
    const res = makeRes();

    await handler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res._body as any).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cursor helper unit tests
// ---------------------------------------------------------------------------

describe("cursor helpers (encodeCursor / decodeCursor)", () => {
  it("round-trips a valid cursor payload", () => {
    const payload = { createdAt: "2026-08-01T10:00:00.000Z", id: "uuid-42" };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(payload);
  });

  it("returns null for a random string", () => {
    expect(decodeCursor("random-garbage")).toBeNull();
  });

  it("returns null for base64url-encoded JSON missing the id field", () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: "2026-08-01T10:00:00.000Z" }),
    ).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null when createdAt is not a valid date", () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "uuid-1" }),
    ).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });
});
