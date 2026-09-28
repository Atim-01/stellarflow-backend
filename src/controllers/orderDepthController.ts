import { Request, Response } from "express";
import { orderDepthAggregatorService } from "../services/orderDepthAggregatorService";
import { sendApiError } from "../lib/apiError";

export async function getOrderDepth(req: Request, res: Response) {
  const { market, tickSize } = req.query;

  if (typeof market !== "string" || typeof tickSize !== "string") {
    return sendApiError(res, 400, "VALIDATION_ERROR", "market and tickSize are required");
  }

  try {
    const cachedDepth = await orderDepthAggregatorService.getCachedDepth(market);

    if (cachedDepth) {
      res.json({ success: true, data: cachedDepth });
      return;
    }

    const depth = await orderDepthAggregatorService.getDepth(market, tickSize);
    await orderDepthAggregatorService.updateDepth(market, tickSize);
    res.json({ success: true, data: depth });
  } catch (error) {
    sendApiError(res, 500, "INTERNAL_ERROR", "Unable to load order depth");
  }
}
