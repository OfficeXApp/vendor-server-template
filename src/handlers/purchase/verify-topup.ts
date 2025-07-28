// src/handlers/purchase/verify-topup.ts

import { FastifyReply, FastifyRequest } from "fastify";
import { CustomerPurchase, CustomerPurchaseID } from "../../types/core.types";
import {
  checkWalletBalances,
  sendFromGasTank,
  sendERC20Transfer, // New import for stablecoin transfers
} from "../../services/wallets"; // Import functions directly
import { parseEther } from "viem"; // Import parseEther for BigInt conversion

// Define a threshold for minimum ETH balance required for transactions
// This is the minimum ETH a wallet should have to cover gas for a token transfer.
const MIN_ETH_FOR_GAS_WEI = parseEther("0.00005"); // 0.00005 ETH in Wei (adjust as needed)
const ETH_GAS_TOPUP_AMOUNT_ETH = 0.0001; // Amount of ETH to send if gas is low

// Environment variables for token addresses (must be consistent with wallets.ts)
// Ensure these are loaded and available in your application's environment.
const USDC_ADDRESS = process.env.USDC_ADDRESS as `0x${string}`;
const USDT_ADDRESS = process.env.USDT_ADDRESS as `0x${string}`;

// POST /purchase/:purchase_id/verify-topup
export const verify_topup_handler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const { purchase_id } = request.params as {
    purchase_id: CustomerPurchaseID;
  };
  request.log.info(`POST /purchase/${purchase_id}/verify-topup called`);

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

    const wallet = await request.server.db.getDepositWalletById(
      purchase.wallet_id
    );
    if (!wallet) {
      reply.status(500).send({ error: "Associated deposit wallet not found." });
      return;
    }

    if (!wallet.offramp_evm_address) {
      reply
        .status(500)
        .send({ error: "Offramp EVM address not configured for this wallet." });
      return;
    }

    // --- Use Wallets Service to check actual balance on the blockchain ---
    const balances = await checkWalletBalances(
      wallet.evm_address as `0x${string}`
    );
    request.log.info(
      `Wallet ${wallet.evm_address} balances: ETH=${balances.eth}, USDC=${balances.usdc}, USDT=${balances.usdt}`
    );

    let currentBlockchainBalanceUSD = 0;
    let tokenToTransferAddress: `0x${string}` | undefined;
    let tokenToTransferAmount: number = 0;

    // Prioritize USDC, then USDT for determining the top-up amount
    if (USDC_ADDRESS && parseFloat(balances.usdc) > 0) {
      currentBlockchainBalanceUSD = parseFloat(balances.usdc);
      tokenToTransferAddress = USDC_ADDRESS;
      tokenToTransferAmount = currentBlockchainBalanceUSD;
    } else if (USDT_ADDRESS && parseFloat(balances.usdt) > 0) {
      currentBlockchainBalanceUSD = parseFloat(balances.usdt);
      tokenToTransferAddress = USDT_ADDRESS;
      tokenToTransferAmount = currentBlockchainBalanceUSD;
    } else {
      request.log.warn(
        `No USDC or USDT found in wallet ${wallet.evm_address}. ETH balance: ${balances.eth}. ` +
          `Assuming top-up is expected in stablecoins, cannot determine USD top-up amount.`
      );
      // If stablecoins are the primary top-up method, and none are found,
      // then currentBlockchainBalanceUSD remains 0, and the condition below will fail.
    }

    const minTargetBalanceForTopup =
      (request.body as { min_target_balance?: number }).min_target_balance ||
      100; // Example threshold

    // Update the wallet's latest_usd_balance in DB with the observed blockchain balance.
    // This reflects the current state of the wallet on-chain.
    await request.server.db.updateDepositWallet(wallet.id, {
      latest_usd_balance: currentBlockchainBalanceUSD,
      updated_at: Date.now(),
    });

    let topupAmount = 0;
    let updatedPurchase: CustomerPurchase | null = null;

    if (currentBlockchainBalanceUSD >= minTargetBalanceForTopup) {
      request.log.info(
        `Funds in wallet ${wallet.id} (${currentBlockchainBalanceUSD} USD) exceeded top-up target (${minTargetBalanceForTopup} USD). ` +
          `Initiating transfer to offramp: ${wallet.offramp_evm_address}`
      );

      // --- Ensure enough ETH for gas before transferring tokens ---
      const ethBalanceWei = parseEther(balances.eth); // Convert string ETH balance to BigInt Wei
      if (ethBalanceWei < MIN_ETH_FOR_GAS_WEI) {
        request.log.info(
          `Wallet ${wallet.evm_address} has low ETH balance (${balances.eth} ETH). Sending ${ETH_GAS_TOPUP_AMOUNT_ETH} ETH for gas.`
        );
        try {
          await sendFromGasTank(wallet.evm_address as `0x${string}`);
          // Return immediately, asking the client to re-verify after the gas transaction confirms.
          // This prevents blocking the request while waiting for gas and then attempting token transfer.
          return reply.status(202).send({
            message:
              "Insufficient ETH for gas. Gas top-up initiated. Please re-verify in a moment.",
            current_wallet_balance_usd: currentBlockchainBalanceUSD,
            min_target_balance_for_topup: minTargetBalanceForTopup,
            gas_topup_sent: true,
          });
        } catch (gasError: any) {
          request.log.error(
            `Failed to send gas to ${wallet.evm_address}:`,
            gasError
          );
          reply
            .status(500)
            .send({ error: "Failed to send gas to deposit wallet." });
          return;
        }
      }

      // --- Perform actual crypto transfer using wallets service ---
      if (tokenToTransferAddress && tokenToTransferAmount > 0) {
        try {
          // WARNING: In production, wallet.private_key should be decrypted securely before use.
          await sendERC20Transfer(
            tokenToTransferAddress,
            wallet.offramp_evm_address as `0x${string}`,
            tokenToTransferAmount,
            wallet.private_key as `0x${string}`
          );
          topupAmount = tokenToTransferAmount; // The amount successfully transferred
        } catch (transferError: any) {
          request.log.error(
            `Error transferring funds from wallet ${wallet.id} to offramp ${wallet.offramp_evm_address}:`,
            transferError
          );
          reply
            .status(500)
            .send({ error: "Failed to transfer funds from deposit wallet." });
          return;
        }
      } else {
        // This case should ideally not be reached if currentBlockchainBalanceUSD was >= minTargetBalanceForTopup
        // and stablecoins are the expected top-up method.
        request.log.error(
          `Logic error: currentBlockchainBalanceUSD (${currentBlockchainBalanceUSD}) met target, ` +
            `but no transferable stablecoin was identified in wallet ${wallet.id}.`
        );
        reply
          .status(500)
          .send({
            error:
              "Internal server error: No transferable stablecoin identified.",
          });
        return;
      }

      // Update purchase balance in DB with the actual amount topped up
      updatedPurchase = await request.server.db.updatePurchaseBalance(
        purchase_id,
        topupAmount
      );

      // Reset wallet's latest_usd_balance in DB after successful transfer
      await request.server.db.updateDepositWallet(wallet.id, {
        latest_usd_balance: 0, // Funds moved out
        updated_at: Date.now(),
      });

      // Placeholder: Notify OfficeX of top-up
      request.log.info(
        `[METERING_SERVICE_PLACEHOLDER] Notifying OfficeX of top-up for purchase ${purchase.customer_purchase_id}.`
      );

      return {
        message: "Top-up verified, funds transferred, and balance updated.",
        new_balance: updatedPurchase?.balance,
        topup_amount: topupAmount,
      };
    } else {
      return {
        message:
          "Top-up not yet verified: Insufficient funds in deposit wallet.",
        current_wallet_balance_usd: currentBlockchainBalanceUSD,
        min_target_balance_for_topup: minTargetBalanceForTopup,
      };
    }
  } catch (error) {
    request.log.error(
      `Error verifying top-up for purchase ${purchase_id}:`,
      error
    );
    reply.status(500).send({ error: "Internal server error" });
  }
};
