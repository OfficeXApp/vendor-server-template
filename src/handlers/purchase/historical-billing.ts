import { FastifyReply, FastifyRequest } from "fastify";
import { CustomerPurchaseID, HistoricalBillingEntry } from "../../types/core.types";

// POST /purchase/:purchase_id/historical-billing
export const historical_billing_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const { purchase_id } = request.params as {
    purchase_id: CustomerPurchaseID;
  };
  const { interval, start_date, end_date } = request.body as {
    interval?: string;
    start_date?: string;
    end_date?: string;
  };
  request.log.info(`POST /purchase/${purchase_id}/historical-billing called`);

  try {
    const purchase = await request.server.db.getCustomerPurchaseById(purchase_id);
    if (!purchase) {
      reply.status(404).send({ error: "Purchase not found" });
      return;
    }

    // Auth: Check CustomerPurchase.customer_billing_api_key
    const authHeader = request.headers["authorization"];
    if (!authHeader || authHeader !== `Bearer ${purchase.customer_billing_api_key}`) {
      reply.status(401).send({ error: "Unauthorized: Invalid API Key" });
      return;
    }

    // Parse dates and set default interval
    const parsedStartDate = start_date ? new Date(start_date) : undefined;
    const parsedEndDate = end_date ? new Date(end_date) : undefined;
    const requestedInterval = interval || "daily"; // Default to daily

    // --- Handler Logic Simplified ---
    const history: HistoricalBillingEntry[] = await request.server.meter.getHistoricalBillingReport(
      purchase_id,
      requestedInterval,
      parsedStartDate,
      parsedEndDate,
    );

    // Format timestamps for better readability in JSON response
    // And ensure total_billed_amount (USD charge amount) is included, which it already is.
    const formattedHistory = history.map((entry) => ({
      time_bucket: entry.time_bucket.toISOString(),
      total_usage_amount: entry.total_usage_amount,
      total_billed_amount: entry.total_billed_amount, // This is the USD charge amount
      purchase_id: entry.purchase_id,
    }));

    return formattedHistory;
  } catch (error) {
    request.log.error(`Error retrieving historical billing for purchase ${purchase_id}:`, error);
    reply.status(500).send({ error: "Internal server error" });
  }
};
