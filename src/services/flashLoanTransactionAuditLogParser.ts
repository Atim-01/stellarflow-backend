import { Prisma } from "@prisma/client";
import { xdr } from "@stellar/stellar-sdk";
import prisma from "../lib/prisma";
import { generateKsuid } from "../utils/ksuid";

export interface FlashLoanTraceEvent {
  topics: unknown;
  value: unknown;
}

export interface FlashLoanExecutionTrace {
  txHash: string;
  ledgerSeq: number;
  events: FlashLoanTraceEvent[];
}

export interface FlashLoanAssetAudit {
  asset: string;
  principal: string;
  returned: string;
  fee: string;
  feeBps: number;
  expectedFee: string;
  valid: boolean;
}

export interface ArbitragePathStep {
  venue: string;
  assetIn: string;
  assetOut: string;
  amountIn: string;
  amountOut: string;
}

export interface FlashLoanAuditRecord {
  txHash: string;
  ledgerSeq: number;
  assets: FlashLoanAssetAudit[];
  arbitragePath: ArbitragePathStep[];
  valid: boolean;
  errors: string[];
}

export interface FlashLoanAuditWriter {
  write(record: FlashLoanAuditRecord): Promise<void>;
}

function decodeScVal(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const scVal = xdr.ScVal.fromXDR(value, "base64") as any;
    const type = scVal.switch().name;
    if (["scvSymbol", "scvString", "scvAddress"].includes(type)) {
      return scVal.value().toString();
    }
    if (
      ["scvU64", "scvI64", "scvU128", "scvI128", "scvU32", "scvI32"].includes(
        type,
      )
    ) {
      return scVal.value().toString();
    }
    if (type === "scvVec")
      return (scVal.vec() ?? []).map((item: unknown) => decodeScVal(item));
    if (type === "scvMap") {
      return Object.fromEntries(
        (scVal.map() ?? []).map((entry: any) => [
          String(decodeScVal(entry.key())),
          decodeScVal(entry.val()),
        ]),
      );
    }
  } catch {
    return value;
  }
  return value;
}

function topicNames(topics: unknown): string[] {
  const values = Array.isArray(topics) ? topics : [topics];
  return values
    .map((topic) => decodeScVal(topic))
    .filter((topic): topic is string => typeof topic === "string");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPositiveBigInt(value: unknown, field: string): bigint {
  try {
    const result = BigInt(String(value));
    if (result <= 0n) throw new Error(`${field} must be positive`);
    return result;
  } catch {
    throw new Error(`${field} must be a positive integer`);
  }
}

function asNonNegativeBigInt(value: unknown, field: string): bigint {
  try {
    const result = BigInt(String(value));
    if (result < 0n) throw new Error(`${field} must not be negative`);
    return result;
  } catch {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

/** Parses flash-loan events, verifies repayment per asset, and records the arbitrage path. */
export class FlashLoanTransactionAuditLogParser {
  constructor(
    private readonly writer: FlashLoanAuditWriter = new PrismaFlashLoanAuditWriter(),
  ) {}

  async parseAndLog(
    trace: FlashLoanExecutionTrace,
  ): Promise<FlashLoanAuditRecord> {
    const assets: FlashLoanAssetAudit[] = [];
    const arbitragePath: ArbitragePathStep[] = [];
    const errors: string[] = [];

    for (const event of trace.events) {
      const names = topicNames(event.topics);
      const value = asRecord(decodeScVal(event.value));
      if (!value) continue;

      if (
        names.includes("FlashLoanBorrowed") ||
        names.includes("FlashLoanRepaid")
      ) {
        try {
          const assetValue = value.asset ?? value.token;
          if (typeof assetValue !== "string" || assetValue.length === 0) {
            throw new Error("asset is required");
          }
          const asset = assetValue;
          const principal = asPositiveBigInt(
            value.principal ?? value.amount,
            "principal",
          );
          const returned = asPositiveBigInt(
            value.returned ?? value.returnedAmount ?? value.repaid,
            "returned amount",
          );
          const fee = asNonNegativeBigInt(value.fee ?? 0, "fee");
          const feeBps = Number(value.feeBps ?? value.feeRateBps ?? 0);
          if (
            !asset ||
            !Number.isInteger(feeBps) ||
            feeBps < 0 ||
            feeBps > 10_000
          ) {
            throw new Error(
              "asset and a fee rate between 0 and 10000 bps are required",
            );
          }
          const expectedFee = (principal * BigInt(feeBps) + 9_999n) / 10_000n;
          const valid =
            returned >= principal + expectedFee && fee >= expectedFee;
          const auditAsset = {
            asset,
            principal: principal.toString(),
            returned: returned.toString(),
            fee: fee.toString(),
            feeBps,
            expectedFee: expectedFee.toString(),
            valid,
          };
          assets.push(auditAsset);
          if (!valid) {
            errors.push(
              `${asset} repayment is insufficient: returned ${returned}, required at least ${principal + expectedFee}.`,
            );
          }
        } catch (error) {
          errors.push(
            `Invalid flash-loan repayment event: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (names.includes("ArbitrageSwap") || names.includes("SwapExecuted")) {
        const venue = String(value.venue ?? value.dex ?? "unknown");
        arbitragePath.push({
          venue,
          assetIn: String(value.assetIn ?? value.inputAsset),
          assetOut: String(value.assetOut ?? value.outputAsset),
          amountIn: String(value.amountIn ?? value.inputAmount),
          amountOut: String(value.amountOut ?? value.outputAmount),
        });
      }
    }

    if (assets.length === 0)
      errors.push("No flash-loan repayment events were found in the trace.");
    const record = {
      txHash: trace.txHash,
      ledgerSeq: trace.ledgerSeq,
      assets,
      arbitragePath,
      valid: errors.length === 0 && assets.every((asset) => asset.valid),
      errors,
    };
    await this.writer.write(record);
    return record;
  }
}

/** Persists normalized flash-loan audit records in the existing central AuditLog table. */
export class PrismaFlashLoanAuditWriter implements FlashLoanAuditWriter {
  async write(record: FlashLoanAuditRecord): Promise<void> {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "AuditLog" (
        "id", "eventType", "actionType", "actorPublicKey", "actorName",
        "actorRole", "eventDetails", "newState", "occurredAt"
      ) VALUES (
        ${generateKsuid()}, 'FLASH_LOAN_EXECUTION', 'ARBITRAGE_PATH',
        'system', 'flash-loan-parser', 'SYSTEM',
        ${JSON.stringify({ txHash: record.txHash, ledgerSeq: record.ledgerSeq, arbitragePath: record.arbitragePath })},
        ${JSON.stringify({ assets: record.assets, valid: record.valid, errors: record.errors })},
        NOW()
      )
    `);
  }
}
