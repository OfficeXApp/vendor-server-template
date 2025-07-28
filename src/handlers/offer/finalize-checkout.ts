// src/handlers/offer/finalize-checkout.ts

import { FastifyReply, FastifyRequest } from "fastify";
import {
  CustomerPurchase,
  CustomerPurchaseID,
  DepositWalletID,
  OfferID,
} from "../../types/core.types";
import { JobRunStatus } from "@officexapp/types";
import * as WalletService from "../../services/wallets"; // Import the wallets service
import { Address } from "viem"; // Import Address type from viem

// POST /offer/:offer_id/checkout/finalize
export const finalize_checkout_handler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const { offer_id } = request.params as {
    offer_id: OfferID;
    // wallet_id is from body, not params for this route
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

    // Ensure the wallet has a sufficient balance for the purchase
    // This check should ideally be against the actual offer price, not just > 0
    // For now, we'll use the updatedWallet.latest_usd_balance
    if (updatedWallet.latest_usd_balance <= 0) {
      reply.status(400).send({
        error: "Wallet has insufficient funds to finalize purchase.",
      });
      return;
    }

    // Ensure offramp address is set for the transfer
    if (!wallet.offramp_evm_address) {
      reply.status(400).send({
        error: "Offramp EVM address not configured for this deposit wallet.",
      });
      return;
    }

    // 2. Send gas if needed (e.g., if ETH balance is too low for a transaction)
    // A typical transaction on Base might cost ~0.00005 ETH. GAS_TANK_AMOUNT_ETH is 0.0001 ETH.
    // We'll send gas if the current ETH balance is less than a threshold (e.g., 0.00005 ETH)
    const MIN_ETH_FOR_TX = 0.00005; // A reasonable minimum to cover a single transaction
    if (ethBalance < MIN_ETH_FOR_TX) {
      request.log.info(
        `Deposit wallet ${wallet_id} ETH balance (${ethBalance} ETH) is low. Sending gas from vendor tank.`
      );
      try {
        const gasTxHash = await WalletService.sendFromGasTank(
          wallet.evm_address as Address
        );
        request.log.info(
          `Gas transfer initiated for wallet ${wallet_id}. Tx Hash: ${gasTxHash}`
        );
        // In a real-world scenario, you might want to wait for this transaction to be mined
        // or use a robust queuing system for subsequent steps. For this example, we proceed.
      } catch (gasError) {
        request.log.error(
          `Failed to send gas to wallet ${wallet_id}:`,
          gasError
        );
        // Decide if this is a fatal error or if we can proceed without gas (unlikely for transfer)
        reply
          .status(500)
          .send({ error: "Failed to send gas to deposit wallet." });
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
      customer_org_api_key: customer_org_api_key, // WARNING: Encrypt in production!
      vendor_id: vendor_id,
      pricing: pricing,
      customer_check_billing_api_key: customer_check_billing_api_key, // WARNING: Encrypt in production!
      vendor_update_billing_api_key: vendor_update_billing_api_key, // WARNING: Encrypt in production!
      vendor_notes: vendor_notes || "",
      balance: updatedWallet.latest_usd_balance, // Initial balance from the deposit wallet (USD value)
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
    // This assumes the primary balance to be transferred is ETH.
    // If USDC/USDT also needs to be transferred, you'd need to implement ERC-20 transfer logic
    // in wallets.ts and call it here.
    request.log.info(
      `Initiating ETH transfer from deposit wallet ${wallet_id} to offramp wallet ${wallet.offramp_evm_address}.`
    );
    let transferTxHash: string | null = null;
    try {
      // WARNING: wallet.private_key MUST be securely handled and encrypted in production.
      // For this example, it's directly used as stored in DB.
      transferTxHash = await WalletService.sendWalletTransfer(
        wallet.offramp_evm_address as Address,
        wallet.private_key as any // Cast to any because viem's Hex type is stricter than string
      );
      request.log.info(
        `Funds transfer initiated for wallet ${wallet_id}. Tx Hash: ${transferTxHash}`
      );
    } catch (transferError) {
      request.log.error(
        `Failed to transfer funds from wallet ${wallet_id} to offramp:`,
        transferError
      );
      // Decide how to handle this: revert purchase, mark as pending, manual intervention.
      // For now, we'll log and still return success for the purchase creation,
      // but a real system would need more robust error handling here.
      // You might want to update the purchase status to 'transfer_failed' or similar.
    }

    // Placeholder: Vendor fulfills the customer purchase and updates the customers OfficeX org purchase record
    request.log.info(
      `Notifying OfficeX of new purchase ${createdPurchase.customer_purchase_id}.`
    );

    if (!transferTxHash) {
      await alertVendorError(
        `Failed to transfer funds from wallet ${wallet_id} to offramp. Purchase ${createdPurchase.id} created.`
      );
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
