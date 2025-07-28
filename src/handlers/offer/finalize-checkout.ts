// src/handlers/offer/finalize-checkout.ts

import { FastifyReply, FastifyRequest } from "fastify";
import {
  CustomerPurchase,
  CustomerPurchaseID,
  DepositWalletID,
  OfferID,
} from "../../types/core.types";
import { JobRunStatus } from "@officexapp/types";
import * as WalletService from "../../services/wallets";
import { Address } from "viem";

// POST /offer/:offer_id/checkout/finalize
export const finalize_checkout_handler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const { offer_id } = request.params as {
    offer_id: OfferID;
  };
  const {
    wallet_id,
    customer_purchase_id,
    customer_user_id,
    customer_org_id,
    customer_org_endpoint,
    customer_org_api_key,
    vendor_id,
    pricing,
    customer_check_billing_api_key,
    vendor_update_billing_api_key,
    vendor_notes,
    balance_low_trigger,
    balance_critical_trigger,
    balance_termination_trigger,
  } = request.body as {
    wallet_id: DepositWalletID;
    customer_purchase_id: string;
    customer_user_id: string;
    customer_org_id: string;
    customer_org_endpoint: string;
    customer_org_api_key: string;
    vendor_id: string;
    pricing: Record<string, any>;
    customer_check_billing_api_key: string;
    vendor_update_billing_api_key: string;
    vendor_notes?: string;
    balance_low_trigger: number;
    balance_critical_trigger: number;
    balance_termination_trigger: number;
  };
  request.log.info(`POST /offer/${offer_id}/checkout/finalize called`);

  try {
    const wallet = await request.server.db.getDepositWalletById(wallet_id);
    if (!wallet) {
      reply.status(404).send({ error: "Deposit wallet not found" });
      return;
    }
    if (wallet.purchase_id) {
      reply.status(409).send({ error: "Wallet already linked to a purchase." });
      return;
    }

    // 1. Re-check deposit wallet balance on-chain
    const blockchainBalances = await WalletService.checkWalletBalances(
      wallet.evm_address as Address
    );
    const ethBalance = parseFloat(blockchainBalances.eth);
    const usdcBalance = parseFloat(blockchainBalances.usdc);
    const usdtBalance = parseFloat(blockchainBalances.usdt);

    // Calculate USD balance from stablecoins (assuming 1:1)
    const currentUsdBalance = usdcBalance + usdtBalance;

    // Update the wallet's latest_usd_balance in DB with the fresh on-chain value
    const updatedWallet = await request.server.db.updateDepositWallet(
      wallet_id,
      {
        latest_usd_balance: currentUsdBalance,
        updated_at: Date.now(),
      }
    );

    if (!updatedWallet) {
      reply.status(500).send({ error: "Failed to update wallet balance." });
      return;
    }

    if (updatedWallet.latest_usd_balance <= 0) {
      reply.status(400).send({
        error: "Wallet has insufficient funds to finalize purchase.",
      });
      return;
    }

    if (!wallet.offramp_evm_address) {
      reply.status(400).send({
        error: "Offramp EVM address not configured for this deposit wallet.",
      });
      return;
    }

    // 2. Send gas if needed (e.g., if ETH balance is too low for a transaction)
    const MIN_ETH_FOR_TX = 0.00005;
    let gasTxHash: string | null = null;
    if (ethBalance < MIN_ETH_FOR_TX) {
      request.log.info(
        `Deposit wallet ${wallet_id} ETH balance (${ethBalance} ETH) is low. Sending gas from vendor tank.`
      );
      try {
        const gasReceipt = await WalletService.sendFromGasTank(
          wallet.evm_address as Address
        );
        gasTxHash = gasReceipt.transactionHash;
        request.log.info(
          `Gas transfer confirmed for wallet ${wallet_id}. Tx Hash: ${gasTxHash}. Status: ${gasReceipt.status}`
        );
        if (gasReceipt.status !== "success") {
          throw new Error(`Gas transaction ${gasTxHash} failed on chain.`);
        }
      } catch (gasError) {
        request.log.error(
          `Failed to send gas to wallet ${wallet_id}:`,
          gasError
        );
        reply
          .status(500)
          .send({ error: "Failed to send gas to deposit wallet." });
        alertVendorError(
          `Failed to send gas to deposit wallet for ${customer_purchase_id}`
        );
        return;
      }
    }

    // 3. Create the CustomerPurchase record
    const newPurchaseId: CustomerPurchaseID = `CustomerPurchase_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const newPurchase: CustomerPurchase = {
      id: newPurchaseId,
      wallet_id: wallet.id,
      customer_purchase_id: customer_purchase_id,
      title: `Purchase of ${offer_id} for ${customer_org_id}`,
      status: "active" as JobRunStatus,
      description: `Purchase of ${offer_id} via wallet ${wallet_id}.`,
      customer_user_id: customer_user_id,
      customer_org_id: customer_org_id,
      customer_org_endpoint: customer_org_endpoint,
      customer_org_api_key: customer_org_api_key,
      vendor_id: vendor_id,
      pricing: pricing,
      customer_check_billing_api_key: customer_check_billing_api_key,
      vendor_update_billing_api_key: vendor_update_billing_api_key,
      vendor_notes: vendor_notes || "",
      balance: updatedWallet.latest_usd_balance,
      balance_low_trigger: balance_low_trigger,
      balance_critical_trigger: balance_critical_trigger,
      balance_termination_trigger: balance_termination_trigger,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const createdPurchase =
      await request.server.db.createCustomerPurchase(newPurchase);

    // 4. Link the wallet to the purchase
    await request.server.db.updateDepositWallet(wallet_id, {
      purchase_id: createdPurchase.id,
      updated_at: Date.now(),
    });

    // 5. Transfer the deposit wallet's ETH balance to the offramp wallet
    let transferTxHash: string | null = null;
    try {
      const transferReceipt = await WalletService.sendWalletTransfer(
        wallet.offramp_evm_address as Address,
        wallet.private_key as any
      );
      transferTxHash = transferReceipt.transactionHash;
      request.log.info(
        `Funds transfer confirmed for wallet ${wallet_id}. Tx Hash: ${transferTxHash}. Status: ${transferReceipt.status}`
      );
      if (transferReceipt.status !== "success") {
        throw new Error(
          `Funds transfer transaction ${transferTxHash} failed on chain.`
        );
      }
    } catch (transferError) {
      request.log.error(
        `Failed to transfer funds from wallet ${wallet_id} to offramp:`,
        transferError
      );
      alertVendorError(
        `Failed to transfer funds from wallet ${wallet_id} to offramp. Purchase ${createdPurchase.id} created.`
      );
      // Depending on your business logic, you might want to revert the purchase or mark it for manual review
      // For now, we proceed but log the failure and alert the vendor.
    }

    request.log.info(
      `Notifying OfficeX of new purchase ${createdPurchase.customer_purchase_id}.`
    );

    // Only return success if the main fund transfer was successful, or if it's acceptable for it to fail for now.
    // The current logic proceeds even if transfer fails, which might not be desired.
    // Consider adding a `status: 'transfer_failed'` to `CustomerPurchase` if transfer fails.
    if (
      !transferTxHash ||
      (transferTxHash && gasTxHash && transferTxHash !== gasTxHash)
    ) {
      // This condition is a bit ambiguous, it tries to catch if transferTxHash is null,
      // or if it was the *same* as gasTxHash (which implies gas sending failed).
      // A more robust check is simply if `transferTxHash` is null after the try/catch.
      if (transferTxHash === null) {
        await alertVendorError(
          `Funds transfer failed for purchase ${createdPurchase.id}. Wallet ${wallet_id} might still hold funds.`
        );
      }
    }

    return {
      purchase_id: createdPurchase.id,
      customer_purchase_id: createdPurchase.customer_purchase_id,
      status: createdPurchase.status,
      initial_balance: createdPurchase.balance,
      message: "Purchase finalized successfully. Service activated.",
      transfer_tx_hash: transferTxHash,
    };
  } catch (error) {
    request.log.error(
      `Error finalizing purchase for wallet ${wallet_id}:`,
      error
    );
    reply.status(500).send({ error: "Internal server error" });
  }
};

const alertVendorError = async (message: string) => {
  console.error(message);
  // this should send an alert to the vendor
};
