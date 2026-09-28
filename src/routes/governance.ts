/**
 * Governance Routes
 *
 * Mounted at: /api/v1/governance
 *
 * Endpoints:
 *   GET /api/v1/governance/voters/:account_id    – voter history + delegation tree
 *   GET /api/v1/governance/proposals/:proposal_id – proposal result + IPFS verification link
 */

import { Router } from "express";
import {
  getVoterProfile,
  governanceVoterCache,
} from "../controllers/governanceController.js";
import { getProposalResult } from "../controllers/governanceProposalController.js";

const router = Router();

/**
 * @swagger
 * /api/v1/governance/voters/{account_id}:
 *   get:
 *     tags:
 *       - Governance
 *     summary: Voter history and delegation tree
 *     description: >
 *       Returns a voter's past on-chain votes (ingested from Soroban GovernanceVoted
 *       events), their active inbound/outbound delegation chain resolved via a
 *       PostgreSQL recursive CTE, and a per-day voting weight trend.
 *     parameters:
 *       - in: path
 *         name: account_id
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^G[A-Z2-7]{55}$'
 *         description: Stellar public key of the voter
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: "Vote history start (ISO-8601). Default: 90 days ago."
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: "Vote history end (ISO-8601). Default: now."
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *         description: Max votes per page.
 *       - in: query
 *         name: cursor
 *         schema: { type: integer }
 *         description: Pagination cursor (nextCursor from previous response).
 *       - in: query
 *         name: trendDays
 *         schema: { type: integer, minimum: 7, maximum: 365, default: 90 }
 *         description: Rolling window for weight trend (days).
 *     responses:
 *       '200':
 *         description: Voter profile
 *       '400':
 *         description: Invalid parameters
 *       '404':
 *         description: No governance activity for this account
 *       '500':
 *         description: Internal server error
 */
router.get("/voters/:account_id", governanceVoterCache(), getVoterProfile);

/**
 * @swagger
 * /api/v1/governance/proposals/{proposal_id}:
 *   get:
 *     tags:
 *       - Governance
 *     summary: Proposal detail with result verification link
 *     description: >
 *       Returns a governance proposal together with its final voting tally and
 *       voter participation. Once the export worker has published the
 *       immutable result snapshot to IPFS, the response also carries the
 *       content hash (CID) and a public gateway verification link for the
 *       snapshot document.
 *     parameters:
 *       - in: path
 *         name: proposal_id
 *         required: true
 *         schema:
 *           type: string
 *           maxLength: 128
 *         description: On-chain proposal identifier
 *     responses:
 *       '200':
 *         description: Proposal detail with IPFS verification link
 *       '400':
 *         description: Invalid proposal identifier
 *       '404':
 *         description: Proposal not found
 *       '500':
 *         description: Internal server error
 */
router.get("/proposals/:proposal_id", getProposalResult);

export default router;
