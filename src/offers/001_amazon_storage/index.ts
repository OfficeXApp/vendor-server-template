import {
  CartCheckoutPatternEnum,
  IRequestCheckoutFinalize_Crypto,
  IRequestCheckoutInit,
  IRequestCheckoutTopup,
  IRequestCheckoutValidate_Crypto,
  IResponseCheckoutFinalize,
  IResponseCheckoutFinalize_Crypto,
  IResponseCheckoutInit_Crypto,
  IResponseCheckoutTopup,
  IResponseCheckoutValidate,
  JobRunStatus,
} from "@officexapp/types";
import { FastifyReply, FastifyRequest } from "fastify";
import { CustomerPurchase, CustomerPurchaseID, GenerateID, IDPrefixEnum, OfferID } from "../../types/core.types";
import * as WalletService from "../../services/wallets";
import { LOCAL_DEV_MODE, vendor_customer_dashboard, vendor_server_endpoint } from "../../constants";
import { Address, formatUnits, Hex, parseUnits } from "viem";
import { alertVendorError } from "../../services/meter";
import { v4 as uuidv4 } from "uuid";
import CHECKOUT_OPTION from "./001_amazon_storage_crypto_wallet_topup_gift_card_only.json";

const minTargetBalance = BigInt(0.5 * 1e6); // 0.01 USDC
const gas_transfer_buffer = BigInt(0.4 * 1e6); // 0.10 USDC ($0.10 to refuel gas, $0.20 of gas, $0.10 for transfer out)

const initCheckout = async (request: FastifyRequest, reply: FastifyReply) => {
  const { checkout_flow_id, org_id, user_id, tracer } = request.body as IRequestCheckoutInit;
  const checkout_session_id = GenerateID.CheckoutSession();
  const tracer_id = tracer || GenerateID.Tracer();

  try {
    // Use the wallets service to create a new random EVM wallet
    // The service handles generating address, private key, seed phrase, and saving to DB
    const createdWallet = await WalletService.createRandomNewWallet(
      CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.offer_id as OfferID,
      checkout_flow_id,
      checkout_session_id,
      `Deposit wallet for offer ${CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.offer_id} - ${checkout_session_id}`,
      `Deposit wallet for offer ${CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.offer_id} - Initiated by user_id=${user_id}, org_id=${org_id}, checkout_session_id=${checkout_session_id}, tracer=${tracer}`,
      // @ts-ignore
      process.env.VENDOR_OFFRAMP_WALLET_ADDRESS || "",
    );

    const response_payload: IResponseCheckoutInit_Crypto = {
      offer_id: CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.offer_id,
      checkout_flow_id,
      checkout_pattern: CartCheckoutPatternEnum.CRYPTO_WALLET_TOPUP,
      checkout_session_id: checkout_session_id,
      vendor_disclaimer: "Top up this dedicated crypto wallet for your AWS S3 storage",
      required_note_from_customer: undefined, // Not required for this checkout pattern
      tracer: tracer_id,
      validation_endpoint: `${vendor_server_endpoint}/v1/checkout/validate`,
      finalization_endpoint: `${vendor_server_endpoint}/v1/checkout/finalize`,
      final_cta: "Claim Giftcard",
      post_payment: {
        vendor_disclaimer:
          "The Amazon S3 Storage Giftcard will be shared with you here as a link. You will be able to access it, but your organization owner may need to grant other users access.",
        needs_cloud_officex: true,
        auth_installation_url: "http://localhost:3002/officex/install/click-worker-complex-task",
        verify_installation_url: "https://google.com",
      },
      crypto_checkout: {
        receiving_address: createdWallet.evm_address,
        token_address: process.env.USDC_ADDRESS || "",
        token_name: "Circle USD (USDC)",
        token_symbol: "USDC",
        token_decimals: 6,
        suggested_amount_decimals: 2,
        minimum_amount_decimals: 1,
        maximum_amount_decimals: 10000,
        chain: process.env.CHAIN_NAME || "",
        chain_explorer_url: process.env.CHAIN_EXPLORER_URL || "",
        vendor_disclaimer: "Only send USDC on BaseL2 to this wallet. Any other token will be lost.",
      },
      requirements: [
        {
          id: "disk_name",
          title: "Disk Name",
          explanation: "Enter your desired disk name",
          type: "text",
          required: true,
          defaultValue: "Amazon S3",
          placeholder: "Enter your desired disk name",
          suffix: "Disk Name",
        },
      ],
    };

    return reply.status(200).send(response_payload);
  } catch (error) {
    request.log.error(`Error creating deposit wallet for offer ${CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.offer_id}:`, error);
    return reply.status(500).send({ error: "Internal server error" });
  }
};

const validateCheckout = async (request: FastifyRequest, reply: FastifyReply) => {
  const { checkout_flow_id, checkout_session_id, note, tracer } = request.body as IRequestCheckoutValidate_Crypto;

  try {
    const wallet = await request.server.db.getCheckoutWalletByCheckoutSessionID(checkout_session_id);
    if (!wallet) {
      const error_message = `Wallet not found for checkout_session_id=${checkout_session_id}`;
      const response_payload: IResponseCheckoutValidate = {
        success: false,
        message: error_message,
        type: CartCheckoutPatternEnum.CRYPTO_WALLET_TOPUP,
        tracer,
        checkout_session_id,
        checkout_flow_id,
        vendor_disclaimer: error_message,
      };
      return reply.status(200).send(response_payload);
    }

    // Use the wallets service to check the actual balance of the EVM address
    const token_balance = await WalletService.getTokenBalance(
      wallet.evm_address as Address,
      // @ts-ignore
      process.env.USDC_ADDRESS || "",
    );

    if (token_balance < minTargetBalance) {
      const error_message = `Insufficient funds in wallet=${wallet.evm_address} for token ${process.env.USDC_ADDRESS}. Required: ${formatUnits(minTargetBalance, 6)}, Found: ${formatUnits(token_balance, 6)}. You can verify this on chain explorer ${process.env.CHAIN_EXPLORER_URL}/address/${wallet.evm_address}`;
      const response_payload: IResponseCheckoutValidate = {
        success: false,
        message: error_message,
        type: CartCheckoutPatternEnum.CRYPTO_WALLET_TOPUP,
        tracer,
        checkout_session_id,
        checkout_flow_id,
        vendor_disclaimer: error_message,
      };
      return reply.status(200).send(response_payload);
    }
    // Update the wallet's latest_usd_balance in DB
    const updatedWallet = await request.server.db.updateCheckoutWallet(wallet.id, {
      latest_usd_balance: Number(formatUnits(token_balance, 6)),
      updated_at: Date.now(),
    });

    if (!updatedWallet) {
      const error_message = `Failed to update balance of wallet=${wallet.evm_address} for checkout_flow_id=${checkout_flow_id} and checkout_session_id=${checkout_session_id}`;
      const response_payload: IResponseCheckoutValidate = {
        success: false,
        message: error_message,
        type: CartCheckoutPatternEnum.CRYPTO_WALLET_TOPUP,
        tracer,
        checkout_session_id,
        checkout_flow_id,
        vendor_disclaimer: error_message,
      };
      return reply.status(200).send(response_payload);
    }

    const success_message = `Payment verified successfully. You currently have ${formatUnits(token_balance, 6)} USDC in your wallet=${wallet.evm_address}. Proceed to finalize checkout.`;
    const response_payload: IResponseCheckoutValidate = {
      success: true,
      message: success_message,
      type: CartCheckoutPatternEnum.CRYPTO_WALLET_TOPUP,
      tracer,
      checkout_session_id,
      checkout_flow_id,
      vendor_disclaimer: success_message,
    };

    return reply.status(200).send(response_payload);
  } catch (error) {
    request.log.error(
      `Error verifying wallet for checkout_flow_id=${checkout_flow_id} and checkout_session_id=${checkout_session_id}:`,
      error,
    );
    return reply.status(500).send({ error: "Internal server error" });
  }
};

const finalizeCheckout = async (request: FastifyRequest, reply: FastifyReply) => {
  const { checkout_flow_id, checkout_session_id, officex_purchase_id, note, tracer, proxy_buyer_data, sweep_tokens } =
    request.body as IRequestCheckoutFinalize_Crypto;

  try {
    const wallet = await request.server.db.getCheckoutWalletByCheckoutSessionID(checkout_session_id);
    if (!wallet) {
      const error_message = `Wallet not found for checkout_session_id=${checkout_session_id}`;
      const response_payload: IResponseCheckoutFinalize = {
        success: false,
        message: error_message,
        tracer,
        receipt: {
          checkout_flow_id,
          vendor_disclaimer: error_message,
          checkout_session_id,
        },
      };
      return reply.status(200).send(response_payload);
    }
    if (wallet.purchase_id) {
      const error_message = `Wallet ${wallet.evm_address} already linked to a purchase ${wallet.purchase_id}, you cannot use it for this checkout_session_id=${checkout_session_id}`;
      const response_payload: IResponseCheckoutFinalize = {
        success: false,
        message: error_message,
        tracer,
        receipt: {
          checkout_session_id,
          vendor_disclaimer: error_message,
          checkout_flow_id,
        },
      };
      return reply.status(200).send(response_payload);
    }

    const token_balance = await WalletService.getTokenBalance(
      wallet.evm_address as Address,
      // @ts-ignore
      process.env.USDC_ADDRESS || "",
    );

    if (token_balance < minTargetBalance) {
      const error_message = `Insufficient funds in wallet=${wallet.evm_address} for token ${process.env.USDC_ADDRESS}. Required: ${formatUnits(minTargetBalance, 6)}, Found: ${formatUnits(token_balance, 6)}. You can verify this on chain explorer ${process.env.CHAIN_EXPLORER_URL}/address/${wallet.evm_address}`;
      const response_payload: IResponseCheckoutValidate = {
        success: false,
        message: error_message,
        type: CartCheckoutPatternEnum.CRYPTO_WALLET_TOPUP,
        tracer,
        checkout_session_id,
        checkout_flow_id,
        vendor_disclaimer: error_message,
      };
      return reply.status(200).send(response_payload);
    }
    const gas_transfer_buffer = BigInt(0.4 * 1e6); // 0.10 USDC ($0.10 to refuel gas, $0.20 of gas, $0.10 for transfer out)

    // Update the wallet's latest_usd_balance in DB
    const updatedWallet = await request.server.db.updateCheckoutWallet(wallet.id, {
      latest_usd_balance: Number(formatUnits(token_balance - gas_transfer_buffer, 6)),
      updated_at: Date.now(),
    });

    if (!updatedWallet) {
      const error_message = `Failed to update balance of wallet=${wallet.evm_address} for checkout_flow_id=${checkout_flow_id} and checkout_session_id=${checkout_session_id}`;
      const response_payload: IResponseCheckoutFinalize = {
        success: false,
        message: error_message,
        tracer,
        receipt: {
          checkout_session_id,
          vendor_disclaimer: error_message,
          checkout_flow_id,
        },
      };
      return reply.status(200).send(response_payload);
    }

    if (!wallet.offramp_evm_address) {
      const error_message = `Offramp EVM address not configured for this wallet=${wallet.evm_address} for checkout_flow_id=${checkout_flow_id} and checkout_session_id=${checkout_session_id}`;
      const response_payload: IResponseCheckoutFinalize = {
        success: false,
        message: error_message,
        tracer,
        receipt: {
          checkout_session_id,
          vendor_disclaimer: error_message,
          checkout_flow_id,
        },
      };
      return reply.status(200).send(response_payload);
    }

    // 2. Send gas to wallet
    let gasTxHash: string | null = null;
    try {
      const gasReceipt = await WalletService.sendFromGasTank(wallet.evm_address as Address);
      gasTxHash = gasReceipt.transactionHash;
      request.log.info(
        `Gas transfer confirmed for wallet=${wallet.evm_address}. Tx Hash: ${gasTxHash}. Status: ${gasReceipt.status}`,
      );
      if (gasReceipt.status !== "success") {
        throw new Error(`Gas transaction ${gasTxHash} failed on chain.`);
      }
    } catch (gasError) {
      request.log.error(`Failed to send gas to wallet=${wallet.evm_address}:`, gasError);
      alertVendorError(
        `Failed to send gas to wallet=${wallet.evm_address} for checkout_flow_id=${checkout_flow_id} and checkout_session_id=${checkout_session_id}`,
      );
      return reply.status(500).send({ error: "Failed to send gas to deposit wallet." });
    }

    const customer_billing_api_key = uuidv4();
    const vendor_billing_api_key = uuidv4();

    // 3. Create the CustomerPurchase record
    const newPurchaseId: CustomerPurchaseID = GenerateID.CustomerPurchase();
    const newPurchase: CustomerPurchase = {
      id: newPurchaseId,
      wallet_id: wallet.id,
      officex_purchase_id: officex_purchase_id,
      checkout_session_id: checkout_session_id,
      title: `Purchase of ${CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.offer_id} on checkout flow ${checkout_flow_id}`,
      description: `Purchase of ${CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY.offer_id} via wallet=${wallet.evm_address} and checkout_flow_id=${checkout_flow_id} during checkout_session_id=${checkout_session_id}. ${proxy_buyer_data ? `Proxy buyer data: ${JSON.stringify(proxy_buyer_data)}` : ""}`,
      customer_user_id: proxy_buyer_data?.user_id || "",
      customer_org_id: proxy_buyer_data?.org_id || "",
      customer_org_endpoint: proxy_buyer_data?.org_endpoint || "",
      vendor_id: process.env.VENDOR_ID || "",
      price_line: `$0.01/GB/month storage, $0.01/GB egress`,
      customer_billing_api_key,
      vendor_billing_api_key,
      vendor_notes: `Created by ${process.env.VENDOR_ID} for checkout_flow_id=${checkout_flow_id} and checkout_session_id=${checkout_session_id} and officex_purchase_id=${officex_purchase_id} and wallet=${wallet.evm_address}. ${proxy_buyer_data ? `Proxy buyer data: ${JSON.stringify(proxy_buyer_data)}` : ""}`,
      balance: updatedWallet.latest_usd_balance,
      balance_low_trigger: Math.min(10, updatedWallet.latest_usd_balance / 5),
      balance_critical_trigger: Math.min(2, updatedWallet.latest_usd_balance / 10),
      balance_termination_trigger: Math.max(0.05, updatedWallet.latest_usd_balance / 100),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const createdPurchase = await request.server.db.createCustomerPurchase(newPurchase);

    // 5. Transfer the deposit wallet's USDC balance to the offramp wallet
    let transferTxHash: string | null = null;
    try {
      // The token to sweep is USDC, as indicated by the validation and init steps
      const usdcTokenAddress = process.env.USDC_ADDRESS as Address;
      // The amount to sweep is the full token_balance (BigInt) converted to a human-readable number
      const amountToSweep = Number(formatUnits(token_balance, 6));

      const transferReceipt = await WalletService.sendERC20Transfer(
        usdcTokenAddress,
        wallet.offramp_evm_address as Address,
        amountToSweep,
        wallet.private_key as Hex, // Ensure private_key is typed as Hex
      );
      transferTxHash = transferReceipt.transactionHash;
      request.log.info(
        `USDC transfer confirmed sent from wallet=${wallet.evm_address} to offramp=${wallet.offramp_evm_address}. Tx Hash: ${transferTxHash}. Status: ${transferReceipt.status}`,
      );
      if (transferReceipt.status !== "success") {
        // If the transaction status is not 'success', it means it reverted on-chain.
        // This is a critical error for a sweep.
        return reply
          .status(500)
          .send({ error: "Failed to transfer USDC from wallet to offramp (transaction reverted)." });
      }
    } catch (transferError) {
      request.log.error(
        `Failed to transfer USDC from wallet ${wallet.evm_address} to offramp=${wallet.offramp_evm_address}:`,
        transferError,
      );
      alertVendorError(
        `Failed to transfer USDC from wallet ${wallet.evm_address} to offramp=${wallet.offramp_evm_address}. Purchase ${createdPurchase.id} created.`,
      );
      return reply.status(500).send({ error: "Failed to transfer USDC from wallet to offramp." });
    }

    request.log.info(`Notifying OfficeX of new purchase ${createdPurchase.officex_purchase_id}.`);

    // if offramp transfer failed, return error
    if (!transferTxHash) {
      alertVendorError(
        `Funds transfer failed for purchase ${createdPurchase.id}. Wallet ${wallet.evm_address} might still hold funds.`,
      );
      return reply.status(500).send({ error: "Failed to transfer funds from wallet to offramp." });
    }
    // if offramp transfer was successful, create the S3 bucket

    const storageGiftCard = await request.server.aws.deployNewS3Bucket(
      `officex-${createdPurchase.id}`,
      `officex-${createdPurchase.id}`,
      `officex-${createdPurchase.id}`,
      {
        officex_purchase_id: createdPurchase.officex_purchase_id,
        purchase_id: createdPurchase.id,
        offer_id: wallet.offer_id,
        checkout_session_id: createdPurchase.checkout_session_id,
      },
    );

    const success_message = `Successful Purchase! You may now redeem your storage gift card or give it to a friend. Here is the redeem link: ${storageGiftCard.redeem_url}`;
    const response_payload: IResponseCheckoutFinalize = {
      success: true,
      message: success_message,
      tracer,
      receipt: {
        vendor_disclaimer: success_message,
        checkout_session_id,
        checkout_flow_id,
        // redeem_code?: string;
        skip_to_final_redirect: storageGiftCard.redeem_url,
        skip_to_final_cta: "View Giftcard",
        vendor_name: "Amazon",
        vendor_id: process.env.VENDOR_ID,
        status: JobRunStatus.PAID,
        description: "Successful Purchase!",
        about_url: `${vendor_customer_dashboard}?checkout_session_id=${checkout_session_id}&customer_billing_api_key=${customer_billing_api_key}`,
        billing_url: `${vendor_customer_dashboard}?checkout_session_id=${checkout_session_id}&customer_billing_api_key=${customer_billing_api_key}`,
        support_url: `${vendor_customer_dashboard}?checkout_session_id=${checkout_session_id}&customer_billing_api_key=${customer_billing_api_key}`,
        title: "Amazon S3 Storage Giftcard | Base L2 Topup Wallet",
        subtitle: "Amazon S3 Storage Giftcard | Base L2 Topup Wallet",
        pricing: "$0.01/GB/month storage, $0.01/GB egress",
        vendor_notes: `Share giftcard with a friend: ${storageGiftCard.redeem_url}`,
      },
    };

    return response_payload;
  } catch (error) {
    request.log.error(`Error finalizing purchase for `, error);
    reply.status(500).send({ error: "Internal server error" });
  }
};

const topupCheckout = async (request: FastifyRequest, reply: FastifyReply) => {
  const { checkout_session_id, tracer, sweep_tokens, note } = request.body as IRequestCheckoutTopup;

  const wallet = await request.server.db.getCheckoutWalletByCheckoutSessionID(checkout_session_id);

  if (!wallet) {
    return reply.status(404).send({ error: "Checkout session not found" });
  }

  try {
    const customerPurchase = await request.server.db.getCustomerPurchaseByCheckoutSessionID(checkout_session_id);
    if (!customerPurchase) {
      const error_message = `Customer purchase record not found for checkout_session_id=${checkout_session_id}. Cannot update balance.`;
      request.log.warn(error_message);
      const response_payload: IResponseCheckoutTopup = {
        vendor_disclaimer: error_message,
        checkout_session_id,
        success: false,
        message: error_message,
        tracer,
      };
      return reply.status(404).send(response_payload);
    }

    // 3. Get the current token balance in the deposit wallet
    const usdcTokenAddress = process.env.USDC_ADDRESS as Address;
    const currentWalletBalance = await WalletService.getTokenBalance(
      wallet.evm_address as Address,
      usdcTokenAddress, // Assuming USDC is the primary token for top-up
    );

    if (currentWalletBalance < minTargetBalance) {
      const error_message = `Insufficient funds in wallet=${wallet.evm_address} for token ${usdcTokenAddress}. Required: ${formatUnits(minTargetBalance, 6)}, Found: ${formatUnits(currentWalletBalance, 6)}. You can verify this on chain explorer ${process.env.CHAIN_EXPLORER_URL}/address/${wallet.evm_address}`;
      request.log.warn(error_message);
      const response_payload: IResponseCheckoutTopup = {
        success: false,
        message: error_message,
        vendor_disclaimer: error_message,
        checkout_session_id,
        tracer,
      };
      return reply.status(200).send(response_payload);
    }

    // 4. Send gas to the deposit wallet if needed for the sweep transaction
    let gasTxHash: string | null = null;
    try {
      const gasReceipt = await WalletService.sendFromGasTank(wallet.evm_address as Address);
      gasTxHash = gasReceipt.transactionHash;
      request.log.info(
        `Gas transfer confirmed for wallet=${wallet.evm_address}. Tx Hash: ${gasTxHash}. Status: ${gasReceipt.status}`,
      );
      if (gasReceipt.status !== "success") {
        throw new Error(`Gas transaction ${gasTxHash} failed on chain.`);
      }
    } catch (gasError) {
      request.log.error(`Failed to send gas to wallet=${wallet.evm_address} for sweep:`, gasError);
      alertVendorError(
        `Failed to send gas to wallet=${wallet.evm_address} for checkout_session_id=${checkout_session_id} and vendor_purchase_id=${wallet.purchase_id}`,
      );
      return reply.status(500).send({ error: "Failed to prepare wallet for token sweep (gas transfer failed)." });
    }

    // 5. Sweep the tokens from the deposit wallet to the offramp wallet
    if (!wallet.offramp_evm_address) {
      const error_message = `Offramp EVM address not configured for wallet=${wallet.evm_address}. Cannot sweep tokens.`;
      request.log.error(error_message);
      const response_payload: IResponseCheckoutTopup = {
        vendor_disclaimer: error_message,
        checkout_session_id,
        success: false,
        message: error_message,
        tracer,
      };
      return reply.status(500).send(response_payload);
    }

    let transferTxHashes: string[] = [];
    for (const tokenAddress of sweep_tokens || []) {
      const tokenBalance = await WalletService.getTokenBalance(wallet.evm_address as Address, tokenAddress as Address);

      if (tokenBalance > 0) {
        try {
          const amountToSweep = Number(formatUnits(tokenBalance, 6)); // Assuming 6 decimals for all swept tokens
          const transferReceipt = await WalletService.sendERC20Transfer(
            tokenAddress as Address,
            wallet.offramp_evm_address as Address,
            amountToSweep,
            wallet.private_key as Hex,
          );
          transferTxHashes.push(transferReceipt.transactionHash);
          request.log.info(
            `Token ${tokenAddress} transfer confirmed from wallet=${wallet.evm_address} to offramp=${wallet.offramp_evm_address}. Tx Hash: ${transferReceipt.transactionHash}. Status: ${transferReceipt.status}`,
          );
          if (transferReceipt.status !== "success") {
            throw new Error(`Sweep of token ${tokenAddress} failed: transaction reverted on chain.`);
          }
        } catch (transferError) {
          request.log.error(
            `Failed to sweep token ${tokenAddress} from wallet ${wallet.evm_address} to offramp=${wallet.offramp_evm_address}:`,
            transferError,
          );
          alertVendorError(
            `Failed to sweep token ${tokenAddress} from wallet ${wallet.evm_address} for checkout_session_id=${checkout_session_id} and vendor_purchase_id=${wallet.purchase_id}.`,
          );
          return reply.status(500).send({ error: `Failed to sweep token ${tokenAddress} from deposit wallet.` });
        }
      } else {
        request.log.info(`No balance found for token ${tokenAddress} in wallet ${wallet.evm_address}. Skipping sweep.`);
      }
    }

    // 6. Update the USD balance in the CustomerPurchase record
    const netUsdBalance = Number(formatUnits(currentWalletBalance - gas_transfer_buffer, 6));

    const updatedPurchase = await request.server.db.updateCustomerPurchase(customerPurchase.id, {
      balance: netUsdBalance,
      updated_at: Date.now(),
    });

    if (!updatedPurchase) {
      const error_message = `Failed to update USD balance for checkout_session_id=${checkout_session_id}. Tokens may have been swept.`;
      request.log.error(error_message);
      alertVendorError(error_message);
      const response_payload: IResponseCheckoutTopup = {
        vendor_disclaimer: error_message,
        checkout_session_id,
        success: false,
        message: error_message,
        tracer,
      };
      return reply.status(500).send(response_payload);
    }

    // 7. Construct and send success response
    const success_message = `Top-up verified, tokens swept, and USD balance updated successfully for checkout_session_id=${checkout_session_id}. Transaction hashes: ${transferTxHashes.join(", ")}. New balance: $${netUsdBalance.toFixed(2)}.`;
    const response_payload: IResponseCheckoutTopup = {
      vendor_disclaimer: success_message,
      checkout_session_id: checkout_session_id,
      success: true,
      message: success_message,
      tracer,
    };

    return reply.status(200).send(response_payload);
  } catch (e) {
    alertVendorError(
      `Critical error in verifyTopup for checkout_session_id=${checkout_session_id}, vendor_purchase_id=${wallet.purchase_id}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return reply.status(500).send({ error: "Internal server error during top-up verification and sweep." });
  }
};

export const CRYPTO_WALLET_TOPUP_GIFT_CARD_ONLY = {
  checkout_flow_id: CHECKOUT_OPTION.checkout_flow_id,
  offer_id: CHECKOUT_OPTION.offer_id,
  initCheckout,
  validateCheckout,
  finalizeCheckout,
  topupCheckout,
};
