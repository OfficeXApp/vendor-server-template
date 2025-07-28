// src/handlers/offer/create-deposit-wallet.ts

import { FastifyReply, FastifyRequest } from "fastify";
import {
  DepositWallet,
  DepositWalletID,
  OfferID,
} from "../../types/core.types";
import { Address } from "viem";
import * as WalletService from "../../services/wallets";

// POST /offer/:offer_id/checkout/wallet/create
export const create_deposit_wallet_handler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const { offer_id } = request.params as { offer_id: OfferID };
  const { title, description, min_target_balance, offramp_evm_address } =
    request.body as {
      title?: string; // Make optional as per new wallet service
      description?: string; // Make optional as per new wallet service
      min_target_balance: number;
      offramp_evm_address?: Address; // Use Address type
    };
  request.log.info(`POST /offer/${offer_id}/checkout/wallet/create called`);

  try {
    // Use the wallets service to create a new random EVM wallet
    // The service handles generating address, private key, seed phrase, and saving to DB.
    const createdWallet = await WalletService.createRandomNewWallet(
      offer_id,
      title,
      description,
      offramp_evm_address
    );

    // Return only necessary public info
    return {
      wallet_id: createdWallet.id,
      evm_address: createdWallet.evm_address,
      min_target_balance: min_target_balance, // This is a request parameter, not a wallet property
      message:
        "Deposit wallet created. Please send funds to the provided address.",
    };
  } catch (error) {
    request.log.error(
      `Error creating deposit wallet for offer ${offer_id}:`,
      error
    );
    reply.status(500).send({ error: "Internal server error" });
  }
};
