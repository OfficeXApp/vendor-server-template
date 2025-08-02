import { FastifyReply, FastifyRequest } from "fastify";
import { CustomerPurchaseID } from "../../types/core.types";

// GET /purchase/:purchase_id
export const get_purchase_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const { purchase_id } = request.params as {
    purchase_id: CustomerPurchaseID;
  };
  request.log.info(`GET /purchase/${purchase_id} called`);

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

    const checkout_wallet = await request.server.db.getCheckoutWalletById(purchase.wallet_id);
    if (!checkout_wallet) {
      reply.status(404).send({ error: "Checkout wallet not found" });
      return;
    }

    // Return relevant purchase details (excluding sensitive keys)
    // Do NOT return customer_org_api_key, vendor_billing_api_key, private_key, seed_phrase
    return {
      purchase: {
        ...purchase,
        customer_billing_api_key: undefined,
        vendor_billing_api_key: undefined,
        tracer: undefined,
        metadata: undefined,
      },
      checkout_wallet: {
        ...checkout_wallet,
        private_key: undefined,
        seed_phrase: undefined,
        tracer: undefined,
        metadata: undefined,
      },
    };
  } catch (error) {
    request.log.error(`Error getting purchase ${purchase_id}:`, error);
    reply.status(500).send({ error: "Internal server error" });
  }
};
