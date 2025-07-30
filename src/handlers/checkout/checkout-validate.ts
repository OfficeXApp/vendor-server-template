// src/handlers/offer/verify-deposit-wallet.ts

import { FastifyReply, FastifyRequest } from "fastify";
import { CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY } from "../../offers/001_amazon_storage";
import { IRequestCheckoutValidate } from "@officexapp/types";

// POST /offer/:offer_id/checkout/validate
export const verify_deposit_wallet_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const { checkout_flow_id } = request.body as IRequestCheckoutValidate;

  switch (checkout_flow_id) {
    case CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.checkout_flow_id:
      return await CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.validateCheckout(request, reply);
    default:
      return reply.status(404).send({ error: "Checkout flow not found" });
  }
};
