// src/handlers/checkout/checkout-topup.ts

import { FastifyReply, FastifyRequest } from "fastify";
import { CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY } from "../../offers/001_amazon_storage";
import { IRequestCheckoutTopup } from "@officexapp/types";

// POST /checkout/topup
export const checkout_topup_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const { checkout_session_id } = request.body as IRequestCheckoutTopup;

  const checkout_wallet = await request.server.db.getCheckoutWalletByCheckoutSessionID(checkout_session_id);

  if (!checkout_wallet) {
    return reply.status(404).send({ error: "Checkout session not found" });
  }

  switch (checkout_wallet.checkout_flow_id) {
    case CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.checkout_flow_id:
      return await CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.topupCheckout(request, reply);
    default:
      return reply.status(404).send({ error: "Checkout flow not found" });
  }
};
