// src/handlers/offer/finalize-checkout.ts

import { FastifyReply, FastifyRequest } from "fastify";
import { IRequestCheckoutValidate } from "@officexapp/types";
import { CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY } from "../../offers/001_amazon_storage";

// POST /offer/:offer_id/checkout/finalize
export const finalize_checkout_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const { checkout_flow_id } = request.body as IRequestCheckoutValidate;

  switch (checkout_flow_id) {
    case CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.checkout_flow_id:
      return await CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.finalizeCheckout(request, reply);
    default:
      return reply.status(404).send({ error: "Checkout flow not found" });
  }
};
