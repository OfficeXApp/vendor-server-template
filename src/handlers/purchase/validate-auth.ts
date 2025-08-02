import { FastifyReply, FastifyRequest } from "fastify";
import { CustomerPurchaseID } from "../../types/core.types";

// POST /purchase/:purchase_id/validate-auth
export const validate_auth_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const { purchase_id } = request.params as {
    purchase_id: CustomerPurchaseID;
  };
  const { api_key } = request.body as {
    api_key: string;
  };

  try {
    const purchase = await request.server.db.getCustomerPurchaseById(purchase_id);
    if (!purchase) {
      reply.status(200).send({ valid: false, message: "Purchase not found" });
      return;
    }
    if (api_key !== purchase.customer_billing_api_key) {
      reply.status(200).send({ valid: false, message: "Unauthorized: Invalid API Key" });
      return;
    }

    reply.status(200).send({ valid: true, message: "Authorized" });
  } catch (error) {
    request.log.error(`Error validating auth for purchase ${purchase_id}:`, error);
    reply.status(500).send({ error: "Internal server error" });
  }
};
