// src/handlers/offer/create-deposit-wallet.ts

import { FastifyReply, FastifyRequest } from "fastify";
import { IRequestCheckoutInit } from "@officexapp/types";
import { CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY } from "../../offers/001_amazon_storage";

// POST /checkout/initiate
export const checkout_init_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const { checkout_flow_id } = request.body as IRequestCheckoutInit;

  switch (checkout_flow_id) {
    case CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.checkout_flow_id:
      return await CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.initCheckout(request, reply);
    default:
      return reply.status(404).send({ error: "Checkout flow not found" });
  }
};
