// // src/handlers/purchase/verify-topup.ts

// import { FastifyReply, FastifyRequest } from "fastify";
// import { CustomerPurchase, CustomerPurchaseID } from "../../types/core.types";
// import { sendFromGasTank, sendERC20Transfer } from "../../services/wallets";
// import { parseEther } from "viem";

// const MIN_ETH_FOR_GAS_WEI = parseEther("0.00005");
// const ETH_GAS_TOPUP_AMOUNT_ETH = 0.0001;

// const USDC_ADDRESS = process.env.USDC_ADDRESS as `0x${string}`;
// const USDT_ADDRESS = process.env.USDT_ADDRESS as `0x${string}`;

// // POST /purchase/:purchase_id/verify-topup
// export const verify_topup_handler = async (request: FastifyRequest, reply: FastifyReply) => {
//   const { purchase_id } = request.params as {
//     purchase_id: CustomerPurchaseID;
//   };
//   request.log.info(`POST /purchase/${purchase_id}/verify-topup called`);

//   try {
//     const purchase = await request.server.db.getCustomerPurchaseById(purchase_id);
//     if (!purchase) {
//       reply.status(404).send({ error: "Purchase not found" });
//       return;
//     }

//     const authHeader = request.headers["authorization"];
//     if (!authHeader || authHeader !== `Bearer ${purchase.customer_billing_api_key}`) {
//       reply.status(401).send({ error: "Unauthorized: Invalid API Key" });
//       return;
//     }

//     const wallet = await request.server.db.getCheckoutWalletById(purchase.wallet_id);
//     if (!wallet) {
//       reply.status(500).send({ error: "Associated deposit wallet not found." });
//       return;
//     }

//     if (!wallet.offramp_evm_address) {
//       reply.status(500).send({ error: "Offramp EVM address not configured for this wallet." });
//       return;
//     }

//     const balances = await checkWalletBalances(wallet.evm_address as `0x${string}`);
//     request.log.info(
//       `Wallet ${wallet.evm_address} balances: ETH=${balances.eth}, USDC=${balances.usdc}, USDT=${balances.usdt}`,
//     );

//     let currentBlockchainBalanceUSD = 0;
//     let tokenToTransferAddress: `0x${string}` | undefined;
//     let tokenToTransferAmount: number = 0;

//     if (USDC_ADDRESS && parseFloat(balances.usdc) > 0) {
//       currentBlockchainBalanceUSD = parseFloat(balances.usdc);
//       tokenToTransferAddress = USDC_ADDRESS;
//       tokenToTransferAmount = currentBlockchainBalanceUSD;
//     } else if (USDT_ADDRESS && parseFloat(balances.usdt) > 0) {
//       currentBlockchainBalanceUSD = parseFloat(balances.usdt);
//       tokenToTransferAddress = USDT_ADDRESS;
//       tokenToTransferAmount = currentBlockchainBalanceUSD;
//     } else {
//       request.log.warn(
//         `No USDC or USDT found in wallet ${wallet.evm_address}. ETH balance: ${balances.eth}. ` +
//           `Assuming top-up is expected in stablecoins, cannot determine USD top-up amount.`,
//       );
//     }

//     await request.server.db.updateCheckoutWallet(wallet.id, {
//       latest_usd_balance: currentBlockchainBalanceUSD,
//       updated_at: Date.now(),
//     });

//     let topupAmount = 0;
//     let updatedPurchase: CustomerPurchase | null = null;

//     const minTargetBalanceForTopup = (request.body as { min_target_balance?: number }).min_target_balance || 100;

//     if (currentBlockchainBalanceUSD >= minTargetBalanceForTopup) {
//       request.log.info(
//         `Funds in wallet ${wallet.id} (${currentBlockchainBalanceUSD} USD) exceeded top-up target (${minTargetBalanceForTopup} USD). ` +
//           `Initiating transfer to offramp: ${wallet.offramp_evm_address}`,
//       );

//       const ethBalanceWei = parseEther(balances.eth);
//       if (ethBalanceWei < MIN_ETH_FOR_GAS_WEI) {
//         request.log.info(
//           `Wallet ${wallet.evm_address} has low ETH balance (${balances.eth} ETH). Sending ${ETH_GAS_TOPUP_AMOUNT_ETH} ETH for gas.`,
//         );
//         try {
//           const gasReceipt = await sendFromGasTank(wallet.evm_address as `0x${string}`);
//           if (gasReceipt.status !== "success") {
//             throw new Error(`Gas top-up transaction ${gasReceipt.transactionHash} failed on chain.`);
//           }
//           // If gas top-up was initiated and confirmed, we should re-check balances
//           // or instruct the client to retry after some time.
//           // Returning 202 (Accepted) is a good pattern here, indicating the operation is ongoing.
//           return reply.status(202).send({
//             message: "Insufficient ETH for gas. Gas top-up initiated and confirmed. Please re-verify shortly.",
//             current_wallet_balance_usd: currentBlockchainBalanceUSD,
//             min_target_balance_for_topup: minTargetBalanceForTopup,
//             gas_topup_sent: true,
//             gas_topup_tx_hash: gasReceipt.transactionHash,
//           });
//         } catch (gasError: any) {
//           request.log.error(`Failed to send gas to ${wallet.evm_address}:`, gasError);
//           reply.status(500).send({ error: "Failed to send gas to deposit wallet." });
//           return;
//         }
//       }

//       if (tokenToTransferAddress && tokenToTransferAmount > 0) {
//         try {
//           const transferReceipt = await sendERC20Transfer(
//             tokenToTransferAddress,
//             wallet.offramp_evm_address as `0x${string}`,
//             tokenToTransferAmount,
//             wallet.private_key as `0x${string}`,
//           );
//           if (transferReceipt.status !== "success") {
//             throw new Error(`ERC-20 transfer transaction ${transferReceipt.transactionHash} failed on chain.`);
//           }
//           topupAmount = tokenToTransferAmount;
//         } catch (transferError: any) {
//           request.log.error(
//             `Error transferring funds from wallet ${wallet.id} to offramp ${wallet.offramp_evm_address}:`,
//             transferError,
//           );
//           reply.status(500).send({ error: "Failed to transfer funds from deposit wallet." });
//           return;
//         }
//       } else {
//         request.log.error(
//           `Logic error: currentBlockchainBalanceUSD (${currentBlockchainBalanceUSD}) met target, ` +
//             `but no transferable stablecoin was identified in wallet ${wallet.id}.`,
//         );
//         reply.status(500).send({
//           error: "Internal server error: No transferable stablecoin identified.",
//         });
//         return;
//       }

//       updatedPurchase = await request.server.db.updatePurchaseBalance(purchase_id, topupAmount);

//       await request.server.db.updateCheckoutWallet(wallet.id, {
//         latest_usd_balance: 0,
//         updated_at: Date.now(),
//       });

//       request.log.info(
//         `[METERING_SERVICE_PLACEHOLDER] Notifying OfficeX of top-up for purchase ${purchase.officex_purchase_id}.`,
//       );

//       return {
//         message: "Top-up verified, funds transferred, and balance updated.",
//         new_balance: updatedPurchase?.balance,
//         topup_amount: topupAmount,
//       };
//     } else {
//       return {
//         message: "Top-up not yet verified: Insufficient funds in deposit wallet.",
//         current_wallet_balance_usd: currentBlockchainBalanceUSD,
//         min_target_balance_for_topup: minTargetBalanceForTopup,
//       };
//     }
//   } catch (error) {
//     request.log.error(`Error verifying top-up for purchase ${purchase_id}:`, error);
//     reply.status(500).send({ error: "Internal server error" });
//   }
// };
