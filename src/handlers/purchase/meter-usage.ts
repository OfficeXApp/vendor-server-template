import { FastifyReply, FastifyRequest } from "fastify";
import { CustomerPurchaseID } from "../../types/core.types";

// POST /purchase/:purchase_id/meter-usage
export const meter_usage_handler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const { purchase_id } = request.params as {
    purchase_id: CustomerPurchaseID;
  };
  const { usage_amount, unit, cost_incurred, description, metadata } =
    request.body as {
      usage_amount: number;
      unit: string;
      cost_incurred: number;
      description?: string;
      metadata?: Record<string, any>;
    };
  request.log.info(`POST /purchase/${purchase_id}/notify-usage called`);

  try {
    const purchase =
      await request.server.db.getCustomerPurchaseById(purchase_id);
    if (!purchase) {
      reply.status(404).send({ error: "Purchase not found" });
      return;
    }

    // Auth: Check CustomerPurchase.vendor_update_billing_api_key
    const authHeader = request.headers["authorization"];
    if (
      !authHeader ||
      authHeader !== `Bearer ${purchase.vendor_update_billing_api_key}`
    ) {
      reply.status(401).send({ error: "Unauthorized: Invalid API Key" });
      return;
    }

    // --- Handler Logic Simplified ---
    // Delegate the core logic to the MeterService
    const newUsageRecord = await request.server.meter.recordUsage(
      purchase_id,
      usage_amount,
      unit,
      cost_incurred,
      description,
      metadata
    );

    // The MeterService (via DatabaseService) already handles balance checks and logging warnings.
    // You might add a separate notification service here if needed, but it's outside this scope.

    return {
      message: "Usage recorded and balance updated",
      record: {
        id: newUsageRecord.id,
        purchase_id: newUsageRecord.purchase_id,
        timestamp: newUsageRecord.timestamp.toISOString(),
        usage_amount: newUsageRecord.usage_amount,
        unit: newUsageRecord.unit,
        cost_incurred: newUsageRecord.cost_incurred,
      },
    };
  } catch (error) {
    request.log.error(
      `Error recording usage for purchase ${purchase_id}:`,
      error
    );
    reply
      .status(500)
      .send({ error: "Failed to record usage or update balance" });
  }
};
