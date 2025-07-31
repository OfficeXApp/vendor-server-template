import { CheckoutSessionID, JobRunID, OfferID } from "@officexapp/types";
import { CustomerPurchaseID } from "./core.types";

export type ExternalID = string;
export type ExternalPayload = Record<string, any>; // Represents any additional, flexible data

/**
 * Interface for tracking AWS S3 storage resources and associated IAM credentials
 * for a specific gift card or customer purchase.
 * This setup uses a dedicated IAM User with a directly attached policy for S3 owner access.
 */
export interface AmazonS3StorageGiftcard extends ExternalPayload {
  external_id: ExternalID;
  arn_s3_bucket: string;
  iam_user_name: string;
  arn_iam_user: string;
  iam_policy_name: string;
  disk_auth_json: string; // json string
  officex_purchase_id: JobRunID;
  purchase_id: CustomerPurchaseID;
  offer_id: OfferID;
  checkout_session_id: CheckoutSessionID;
}
