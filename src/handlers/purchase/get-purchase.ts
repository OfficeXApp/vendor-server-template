import { FastifyReply, FastifyRequest } from "fastify";
import { CustomerPurchaseID } from "../../types/core.types";

// GET /purchase/:purchase_id
export const get_purchase_handler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const { purchase_id } = request.params as {
    purchase_id: CustomerPurchaseID;
  };
  request.log.info(`GET /purchase/${purchase_id} called`);

  try {
    const purchase =
      await request.server.db.getCustomerPurchaseById(purchase_id);
    if (!purchase) {
      reply.status(404).send({ error: "Purchase not found" });
      return;
    }

    // Auth: Check CustomerPurchase.customer_check_billing_api_key
    const authHeader = request.headers["authorization"];
    if (
      !authHeader ||
      authHeader !== `Bearer ${purchase.customer_check_billing_api_key}`
    ) {
      reply.status(401).send({ error: "Unauthorized: Invalid API Key" });
      return;
    }

    // Return relevant purchase details (excluding sensitive keys)
    return {
      id: purchase.id,
      customer_purchase_id: purchase.customer_purchase_id,
      title: purchase.title,
      status: purchase.status,
      balance: purchase.balance,
      balance_low_trigger: purchase.balance_low_trigger,
      balance_critical_trigger: purchase.balance_critical_trigger,
      balance_termination_trigger: purchase.balance_termination_trigger,
      updated_at: purchase.updated_at,
      pricing: purchase.pricing,
      // Do NOT return customer_org_api_key, vendor_update_billing_api_key, private_key, seed_phrase
    };
  } catch (error) {
    request.log.error(`Error getting purchase ${purchase_id}:`, error);
    reply.status(500).send({ error: "Internal server error" });
  }
};
