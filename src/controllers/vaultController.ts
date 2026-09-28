import { Request, Response } from 'express';
import { VaultService } from '../services/vaultService';
import { systemicRiskService } from '../services/systemicRiskWiring';
import { logger } from '../utils/logger';

export class VaultController {
  private vaultService: VaultService;

  constructor() {
    this.vaultService = VaultService.getInstance();
  }

  async getPosition(req: Request, res: Response): Promise<void> {
    const { account_id } = req.params;

    if (!account_id) {
      res.status(400).json({
        success: false,
        error: 'account_id is required',
      });
      return;
    }

    // Handle case where account_id might be an array
    const accountId = Array.isArray(account_id) ? account_id[0] : account_id;

    try {
      const position = await this.vaultService.getPosition(accountId);
      res.json({
        success: true,
        data: position,
      });
    } catch (error) {
      logger.error(`Failed to get position for account ${accountId}:`, error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch position',
      });
    }
  }

  /**
   * Issue #978 – protocol-wide multi-collateral vault systemic risk score.
   *
   * `S_risk = SUM(V_collateral) / SUM(D_debt)` across every active vault,
   * reported together with the protocol danger level (`NORMAL`, `ELEVATED`,
   * `CRITICAL`) and any parameter adjustment proposal raised by the breach.
   */
  async getSystemicRisk(_req: Request, res: Response): Promise<void> {
    try {
      const snapshot = await systemicRiskService.evaluate();
      res.json({
        success: true,
        data: snapshot,
      });
    } catch (error) {
      logger.error('Failed to evaluate systemic vault risk:', error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to evaluate systemic vault risk',
      });
    }
  }
}
