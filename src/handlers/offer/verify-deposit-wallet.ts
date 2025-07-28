// src/handlers/offer/verify-deposit-wallet.ts

import { FastifyReply, FastifyRequest } from "fastify";
import { DepositWalletID, OfferID } from "../../types/core.types";
import * as WalletService from "../../services/wallets";

// POST /offer/:offer_id/checkout/wallet/:wallet_id/verify
export const verify_deposit_wallet_handler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const { offer_id, wallet_id } = request.params as {
    offer_id: OfferID;
    wallet_id: DepositWalletID;
  };
  request.log.info(
    `POST /offer/${offer_id}/checkout/wallet/${wallet_id}/verify called`
  );

  try {
    const wallet = await request.server.db.getDepositWalletById(wallet_id);
    if (!wallet) {
      reply.status(404).send({ error: "Deposit wallet not found" });
      return;
    }

    // Use the wallets service to check the actual balance of the EVM address
    const blockchainBalances = await WalletService.checkWalletBalances(
      wallet.evm_address as any // Cast to any because viem's Address type is stricter than string
    );

    // Convert stablecoin balances to USD. ETH is not converted to USD here.
    const usdcBalance = parseFloat(blockchainBalances.usdc);
    const usdtBalance = parseFloat(blockchainBalances.usdt);
    const actualBlockchainBalanceUSD = usdcBalance + usdtBalance; // Sum stablecoin balances for USD value

    const minTargetBalance = (request.body as { min_target_balance: number })
      .min_target_balance;

    // Update the wallet's latest_usd_balance in DB
    const updatedWallet = await request.server.db.updateDepositWallet(
      wallet_id,
      {
        latest_usd_balance: actualBlockchainBalanceUSD,
        updated_at: Date.now(),
      }
    );

    if (!updatedWallet) {
      reply.status(500).send({ error: "Failed to update wallet balance." });
      return;
    }

    const isVerified = actualBlockchainBalanceUSD >= minTargetBalance;

    return {
      wallet_id: updatedWallet.id,
      evm_address: updatedWallet.evm_address,
      current_balance_usd: actualBlockchainBalanceUSD,
      min_target_balance: minTargetBalance,
      verified: isVerified,
      message: isVerified
        ? "Payment verified successfully."
        : "Insufficient funds in wallet.",
      // Optionally, include raw crypto balances for client info
      raw_eth_balance: blockchainBalances.eth,
      raw_usdc_balance: blockchainBalances.usdc,
      raw_usdt_balance: blockchainBalances.usdt,
    };
  } catch (error) {
    request.log.error(`Error verifying wallet ${wallet_id}:`, error);
    reply.status(500).send({ error: "Internal server error" });
  }
};
