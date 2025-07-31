import { FastifyReply, FastifyRequest } from "fastify";
import { CustomerPurchaseID, UsageRecord } from "../../types/core.types";

// POST /purchase/:purchase_id/meter-usage
export const meter_usage_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const { purchase_id } = request.params as {
    purchase_id: CustomerPurchaseID;
  };
  const { usage_amount, usage_unit, billed_amount, description, metadata } = request.body as UsageRecord;
  request.log.info(`POST /purchase/${purchase_id}/meter-usage called`);

  try {
    const purchase = await request.server.db.getCustomerPurchaseById(purchase_id);
    if (!purchase) {
      reply.status(404).send({ error: "Purchase not found" });
      return;
    }

    // Auth: Check CustomerPurchase.vendor_billing_api_key
    const authHeader = request.headers["authorization"];
    if (!authHeader || authHeader !== `Bearer ${purchase.vendor_billing_api_key}`) {
      reply.status(401).send({ error: "Unauthorized: Invalid API Key" });
      return;
    }

    // --- Handler Logic Simplified ---
    // Delegate the core logic to the MeterService
    const newUsageRecord = await request.server.meter.recordUsage(request.body as UsageRecord);

    return {
      message: "Usage recorded and balance updated",
      record: {
        id: newUsageRecord.id,
        purchase_id: newUsageRecord.purchase_id,
        timestamp: newUsageRecord.timestamp.toISOString(),
        usage_amount: newUsageRecord.usage_amount,
        usage_unit: newUsageRecord.usage_unit,
        billed_amount: newUsageRecord.billed_amount,
        description: newUsageRecord.description,
        metadata: newUsageRecord.metadata,
      },
    };
  } catch (error) {
    request.log.error(`Error recording usage for purchase ${purchase_id}:`, error);
    reply.status(500).send({ error: "Failed to record usage or update balance" });
  }
};
