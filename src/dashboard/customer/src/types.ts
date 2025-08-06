import type { CheckoutFlowID, CheckoutSessionID, DriveID, UserID } from "@officexapp/types";

export type CustomerPurchaseID = string;
export type CheckoutWalletID = string;
export type OfferID = string;
export type TracerID = string;

// deposit wallets can get created before a purchase
// deposit wallets can get abandoned on checkout
// this reside in postgres
export interface CheckoutWalletFE {
  id: CheckoutWalletID;
  title: string;
  description: string;
  evm_address: string;
  //   private_key: string;
  //   seed_phrase: string;
  latest_usd_balance: number; // 6 decimals
  created_at: number;
  updated_at: number;
  offer_id: OfferID;
  checkout_flow_id: CheckoutFlowID;
  checkout_session_id: CheckoutSessionID;
  //   tracer?: string;
  //   metadata?: Record<string, any>; // Changed from 'string' to 'Record<string, any>' for JSONB
  purchase_id?: CustomerPurchaseID;
  //   offramp_evm_address?: string;
  email?: string;
}

// this resides in postgres
export interface CustomerPurchaseFE {
  id: CustomerPurchaseID;
  wallet_id: CheckoutWalletID;
  checkout_session_id: CheckoutSessionID;
  officex_purchase_id: string;
  title: string;
  description: string;
  customer_user_id: UserID;
  customer_org_id: DriveID;
  customer_org_endpoint: string;
  vendor_id: UserID;
  price_line: string;
  //   customer_billing_api_key: string;
  //   vendor_billing_api_key: string;
  vendor_notes: string;
  balance_low_trigger: number;
  balance_critical_trigger: number;
  balance_termination_trigger: number;
  created_at: number;
  updated_at: number;
  tracer?: string;
  //   metadata?: Record<string, any>
}
