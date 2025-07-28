// src/services/wallets.ts

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  Address,
  Hex,
  PublicClient,
  WalletClient,
  toHex,
  TransactionReceipt,
} from "viem";
import {
  english,
  privateKeyToAccount,
  generateMnemonic,
  mnemonicToAccount,
  Account,
} from "viem/accounts"; // Corrected import for account-related functions
import { base } from "viem/chains"; // Base chain definition
import {
  DepositWallet,
  CustomerPurchaseID,
  DepositWalletID,
  IDPrefixEnum,
  GenerateID,
  OfferID,
} from "../types/core.types"; // Adjust path as needed
import { DatabaseService } from "./database"; // Adjust path as needed
import { v4 as uuidv4 } from "uuid"; // For generating unique IDs

// --- Configuration & Environment Variables ---
// Base chain ID: 8453 (decimal) is used by viem's chain objects.
const CHAIN_ID = base.id;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const USDC_ADDRESS = process.env.USDC_ADDRESS as Address;
const USDT_ADDRESS = process.env.USDT_ADDRESS as Address;
const VENDOR_WALLET_PRIVATE_KEY = process.env.VENDOR_WALLET_PRIVATE_KEY as Hex;
const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_CONFIRMATIONS = 5;

// Basic validation for essential environment variables
if (!RPC_ENDPOINT) {
  throw new Error(
    "RPC_ENDPOINT environment variable is not set. Please provide a Base RPC endpoint."
  );
}
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL environment variable is not set. Please provide a PostgreSQL connection string."
  );
}
if (!VENDOR_WALLET_PRIVATE_KEY) {
  console.warn(
    "VENDOR_WALLET_PRIVATE_KEY environment variable is not set. The `sendFromGasTank` function will not work."
  );
}
if (!USDC_ADDRESS) {
  console.warn(
    "USDC_ADDRESS environment variable is not set. USDC balance checks will be skipped."
  );
}
if (!USDT_ADDRESS) {
  console.warn(
    "USDT_ADDRESS environment variable is not set. USDT balance checks will be skipped."
  );
}

// --- Viem Clients ---
// Public client for read-only operations (e.g., getBalance, readContract)
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_ENDPOINT),
});

// Wallet client for write operations (e.g., sendTransaction).
// The `account` property is set dynamically per transaction or function call.
const walletClient: WalletClient = createWalletClient({
  chain: base,
  transport: http(RPC_ENDPOINT),
});

// --- Database Service Instance ---
const databaseService = new DatabaseService(DATABASE_URL);

// --- Constants ---
// Amount of ETH to send for gas (e.g., for new wallets to cover initial transaction fees)
const GAS_TANK_AMOUNT_ETH = 0.0001; // 0.0001 ETH

// Minimal ERC-20 ABI for `balanceOf` and `decimals` functions
const ERC20_ABI = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  // Added transfer function for completeness, though not directly used in this service yet
  {
    inputs: [
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const; // 'as const' is important for Viem's type inference

// --- Helper Functions ---

/**
 * Connects to the database. This should be called once at application startup.
 */
export async function connectDatabase(): Promise<void> {
  await databaseService.connect();
}

/**
 * Disconnects from the database. This should be called once at application shutdown.
 */
export async function disconnectDatabase(): Promise<void> {
  await databaseService.disconnect();
}

// --- Wallet Service Functions ---

/**
 * Creates a new random EVM wallet (address, private key, seed phrase) and stores its details
 * in the `deposit_wallets` table in the database.
 * @param offerID An optional ID of the offer this wallet might be associated with, for metadata.
 * @returns The created `DepositWallet` object.
 * @throws Error if wallet creation or database storage fails.
 */
export async function createRandomNewWallet(
  offerID: OfferID,
  title?: string,
  description?: string,
  offrampEvmAddress?: Address
): Promise<DepositWallet> {
  try {
    const mnemonic = generateMnemonic(english);
    const account = mnemonicToAccount(mnemonic);
    const hdKey = account.getHdKey();
    const privateKey = toHex(hdKey.privateKey!);

    const newWallet: DepositWallet = {
      id: GenerateID.DepositWallet(),
      title: title || `Wallet for Offer ${offerID || "N/A"}`, // Use provided title or default
      description:
        description || `Randomly generated wallet for a new customer checkout.`, // Use provided description or default
      evm_address: account.address,
      private_key: privateKey, // WARNING: Encrypt in production!
      seed_phrase: mnemonic, // WARNING: Encrypt in production!
      latest_usd_balance: 0,
      offer_id: offerID,
      created_at: Date.now(),
      updated_at: Date.now(),
      tracer: undefined,
      metadata: offerID ? { offerID } : undefined,
      purchase_id: undefined,
      offramp_evm_address: offrampEvmAddress, // Use provided offramp address
    };

    const createdWallet = await databaseService.createDepositWallet(newWallet);
    console.log(
      `Created new wallet: ${createdWallet.evm_address} (ID: ${createdWallet.id})`
    );
    return createdWallet;
  } catch (error: any) {
    console.error("Error creating random new wallet:", error);
    throw new Error(`Failed to create random new wallet: ${error.message}`);
  }
}

/**
 * Derives an EVM account object from a given private key.
 * This function does not interact with the blockchain or database, it's purely cryptographic.
 * @param privateKey The private key (hex string, e.g., "0x...") to derive the account from.
 * @returns The Viem `Account` object containing address, private key, and other properties.
 * @throws Error if the private key is invalid.
 */
export function deriveWalletFromPrivateKey(privateKey: Hex): Account {
  try {
    // privateKeyToAccount returns an object that is assignable to Account and has privateKey
    return privateKeyToAccount(privateKey);
  } catch (error: any) {
    console.error("Error deriving wallet from private key:", error);
    throw new Error(
      `Failed to derive wallet from private key: ${error.message}`
    );
  }
}

/**
 * Derives an EVM account object from a given seed phrase (mnemonic).
 * This function does not interact with the blockchain or database, it's purely cryptographic.
 * @param seed The seed phrase (mnemonic string, e.g., "word1 word2 ...") to derive the account from.
 * @returns The Viem `Account` object containing address, private key, and other properties.
 * @throws Error if the seed phrase is invalid.
 */
export function deriveWalletFromSeed(seed: string): Account {
  try {
    // mnemonicToAccount returns an object that is assignable to Account and has privateKey
    return mnemonicToAccount(seed);
  } catch (error: any) {
    console.error("Error deriving wallet from seed:", error);
    throw new Error(`Failed to derive wallet from seed: ${error.message}`);
  }
}

/**
 * Checks the balances of native ETH, USDC, and USDT for a given public EVM address.
 * Balances are returned as human-readable strings.
 * @param publicKeyAddress The public EVM address (e.g., "0x...") to check balances for.
 * @returns An object containing the balances: `{ eth: string; usdc: string; usdt: string }`.
 * @throws Error if blockchain interaction fails.
 */
export async function checkWalletBalances(
  publicKeyAddress: Address
): Promise<{ eth: string; usdc: string; usdt: string }> {
  try {
    // Get native ETH balance
    const ethBalanceWei = await publicClient.getBalance({
      address: publicKeyAddress,
    });
    const ethBalance = formatEther(ethBalanceWei); // Converts wei (BigInt) to ETH (string)

    let usdcBalance = "0";
    if (USDC_ADDRESS) {
      try {
        // Get USDC token decimals to format the balance correctly
        const usdcDecimals = (await publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "decimals",
        })) as number;
        // Get raw USDC balance (as BigInt)
        const usdcBalanceRaw = (await publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [publicKeyAddress],
        })) as bigint;
        // Convert raw balance to human-readable format
        usdcBalance = (Number(usdcBalanceRaw) / 10 ** usdcDecimals).toFixed(
          usdcDecimals
        );
      } catch (tokenError: any) {
        console.warn(
          `Could not fetch USDC balance for ${publicKeyAddress}: ${tokenError.message}`
        );
      }
    }

    let usdtBalance = "0";
    if (USDT_ADDRESS) {
      try {
        // Get USDT token decimals
        const usdtDecimals = (await publicClient.readContract({
          address: USDT_ADDRESS,
          abi: ERC20_ABI,
          functionName: "decimals",
        })) as number;
        // Get raw USDT balance
        const usdtBalanceRaw = (await publicClient.readContract({
          address: USDT_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [publicKeyAddress],
        })) as bigint;
        // Convert raw balance to human-readable format
        usdtBalance = (Number(usdtBalanceRaw) / 10 ** usdtDecimals).toFixed(
          usdtDecimals
        );
      } catch (tokenError: any) {
        console.warn(
          `Could not fetch USDT balance for ${publicKeyAddress}: ${tokenError.message}`
        );
      }
    }

    return { eth: ethBalance, usdc: usdcBalance, usdt: usdtBalance };
  } catch (error: any) {
    console.error(`Error checking balances for ${publicKeyAddress}:`, error);
    throw new Error(`Failed to check wallet balances: ${error.message}`);
  }
}

/**
 * Sends a small, predefined amount of native ETH (gas) from the vendor's configured
 * gas tank wallet to a specified destination address and waits for confirmations.
 * @param destinationPublicAddress The public EVM address to send gas to.
 * @param confirmations The number of block confirmations to wait for. Defaults to DEFAULT_CONFIRMATIONS.
 * @returns The transaction receipt.
 * @throws Error if the vendor private key is not configured or the transaction fails.
 */
export async function sendFromGasTank(
  destinationPublicAddress: Address,
  confirmations: number = DEFAULT_CONFIRMATIONS
): Promise<TransactionReceipt> {
  if (!VENDOR_WALLET_PRIVATE_KEY) {
    throw new Error(
      "Vendor wallet private key is not configured (VENDOR_WALLET_PRIVATE_KEY). Cannot send gas."
    );
  }

  try {
    const vendorAccount = privateKeyToAccount(VENDOR_WALLET_PRIVATE_KEY);
    const amountWei = parseEther(GAS_TANK_AMOUNT_ETH.toString());

    console.log(
      `Attempting to send ${GAS_TANK_AMOUNT_ETH} ETH from vendor gas tank (${vendorAccount.address}) to ${destinationPublicAddress}...`
    );

    const hash = await walletClient.sendTransaction({
      to: destinationPublicAddress,
      value: amountWei,
      account: vendorAccount,
      chain: base,
    });

    console.log(`Gas tank transaction sent. Hash: ${hash}`);

    console.log(
      `Waiting for ${confirmations} confirmations for gas transaction ${hash}...`
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations,
    });
    console.log(
      `Gas transaction ${hash} confirmed at block ${receipt.blockNumber}. Status: ${receipt.status}`
    );

    return receipt;
  } catch (error: any) {
    console.error(
      `Error sending gas from tank to ${destinationPublicAddress}:`,
      error
    );
    throw new Error(`Failed to send gas from tank: ${error.message}`);
  }
}

/**
 * Sends the entire native ETH balance (minus estimated gas fees) from an origin wallet
 * to a specified destination address and waits for confirmations.
 * @param destinationPublicAddress The public EVM address to send funds to.
 * @param originPrivateKey The private key (Hex string) of the wallet from which to send funds.
 * @param confirmations The number of block confirmations to wait for. Defaults to DEFAULT_CONFIRMATIONS.
 * @returns The transaction receipt.
 * @throws Error if the origin wallet has insufficient balance or the transaction fails.
 */
export async function sendWalletTransfer(
  destinationPublicAddress: Address,
  originPrivateKey: Hex,
  confirmations: number = DEFAULT_CONFIRMATIONS
): Promise<TransactionReceipt> {
  try {
    const originAccount = privateKeyToAccount(originPrivateKey);
    const transferWalletClient = createWalletClient({
      chain: base,
      transport: http(RPC_ENDPOINT),
      account: originAccount,
    });

    const balance = await publicClient.getBalance({
      address: originAccount.address,
    });

    if (balance === 0n) {
      throw new Error(
        `Origin wallet ${originAccount.address} has 0 ETH balance. No transfer possible.`
      );
    }

    const gasEstimate = await publicClient.estimateGas({
      account: originAccount,
      to: destinationPublicAddress,
      value: balance,
    });

    const estimatedGasPrice = await publicClient.getGasPrice();
    const gasCost = gasEstimate * estimatedGasPrice;
    const amountToSend = balance - gasCost;

    if (amountToSend <= 0n) {
      console.warn(
        `Insufficient balance in ${originAccount.address} to cover gas fees for transfer. ` +
          `Balance: ${formatEther(balance)} ETH, Estimated Gas Cost: ${formatEther(gasCost)} ETH.`
      );
      throw new Error(
        "Insufficient balance to cover transaction fees for full transfer."
      );
    }

    console.log(
      `Attempting to send ${formatEther(amountToSend)} ETH from ${originAccount.address} to ${destinationPublicAddress}...`
    );

    const hash = await transferWalletClient.sendTransaction({
      to: destinationPublicAddress,
      value: amountToSend,
      account: originAccount,
      chain: base,
    });

    console.log(`Wallet transfer sent. Hash: ${hash}`);

    console.log(
      `Waiting for ${confirmations} confirmations for ETH transfer ${hash}...`
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations,
    });
    console.log(
      `ETH transfer ${hash} confirmed at block ${receipt.blockNumber}. Status: ${receipt.status}`
    );

    return receipt;
  } catch (error: any) {
    console.error(
      `Error sending wallet transfer from ${originPrivateKey} to ${destinationPublicAddress}:`,
      error
    );
    throw new Error(`Failed to send wallet transfer: ${error.message}`);
  }
}

/**
 * Retrieves the `DepositWallet` record associated with a specific `CustomerPurchaseID`.
 * This function queries the database to first find the purchase, then its linked wallet.
 * @param purchaseID The unique identifier of the customer purchase.
 * @returns The `DepositWallet` object, or `null` if the purchase or its linked wallet is not found.
 * @throws Error if a database operation fails.
 */
export async function getWalletOfPurchase(
  purchaseID: CustomerPurchaseID
): Promise<DepositWallet | null> {
  try {
    // 1. Get the CustomerPurchase record using its ID
    const customerPurchase =
      await databaseService.getCustomerPurchaseById(purchaseID);
    if (!customerPurchase) {
      console.warn(`Customer purchase with ID ${purchaseID} not found.`);
      return null;
    }

    // 2. Use the wallet_id from the CustomerPurchase to get the DepositWallet record
    const depositWallet = await databaseService.getDepositWalletById(
      customerPurchase.wallet_id
    );
    if (!depositWallet) {
      console.warn(
        `Deposit wallet with ID ${customerPurchase.wallet_id} linked to purchase ${purchaseID} not found.`
      );
      return null;
    }

    return depositWallet;
  } catch (error: any) {
    console.error(`Error getting wallet for purchase ${purchaseID}:`, error);
    throw new Error(`Failed to retrieve wallet for purchase: ${error.message}`);
  }
}

/**
 * Sends ERC-20 tokens from an origin wallet to a specified destination address and waits for confirmations.
 * @param tokenAddress The address of the ERC-20 token contract.
 * @param destinationPublicAddress The public EVM address to send tokens to.
 * @param amount Amount in human-readable units (e.g., 10.5 USDC).
 * @param originPrivateKey The private key (Hex string) of the wallet from which to send funds.
 * @param confirmations The number of block confirmations to wait for. Defaults to DEFAULT_CONFIRMATIONS.
 * @returns The transaction receipt.
 * @throws Error if the origin wallet has insufficient balance or the transaction fails.
 */
export async function sendERC20Transfer(
  tokenAddress: Address,
  destinationPublicAddress: Address,
  amount: number,
  originPrivateKey: Hex,
  confirmations: number = DEFAULT_CONFIRMATIONS
): Promise<TransactionReceipt> {
  try {
    const originAccount = privateKeyToAccount(originPrivateKey);
    const transferWalletClient = createWalletClient({
      chain: base,
      transport: http(RPC_ENDPOINT),
      account: originAccount,
    });

    const tokenDecimals = (await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    })) as number;

    const amountRaw = BigInt(Math.floor(amount * 10 ** tokenDecimals));

    const tokenBalanceRaw = (await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [originAccount.address],
    })) as bigint;

    if (tokenBalanceRaw < amountRaw) {
      throw new Error(
        `Insufficient token balance in ${originAccount.address}. Has ${tokenBalanceRaw / 10n ** BigInt(tokenDecimals)} (raw: ${tokenBalanceRaw}), trying to send ${amount} (raw: ${amountRaw}).`
      );
    }

    console.log(
      `Attempting to send ${amount} ERC-20 tokens from ${originAccount.address} to ${destinationPublicAddress}...`
    );

    const { request } = await publicClient.simulateContract({
      account: originAccount,
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [destinationPublicAddress, amountRaw],
      chain: base,
    });

    const hash = await transferWalletClient.writeContract(request);

    console.log(`ERC-20 transfer sent. Hash: ${hash}`);

    console.log(
      `Waiting for ${confirmations} confirmations for ERC-20 transfer ${hash}...`
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations,
    });
    console.log(
      `ERC-20 transfer ${hash} confirmed at block ${receipt.blockNumber}. Status: ${receipt.status}`
    );

    return receipt;
  } catch (error: any) {
    console.error(
      `Error sending ERC-20 transfer from ${originPrivateKey} to ${destinationPublicAddress}:`,
      error
    );
    throw new Error(`Failed to send ERC-20 transfer: ${error.message}`);
  }
}
