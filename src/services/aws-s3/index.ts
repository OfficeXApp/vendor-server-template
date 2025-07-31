import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutBucketPolicyCommand,
  BucketLocationConstraint,
  paginateListObjectsV2,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import {
  IAMClient,
  CreateUserCommand,
  CreateUserCommandOutput,
  CreateAccessKeyCommand,
  PutUserPolicyCommand,
  DeleteUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserPolicyCommand,
  ListAccessKeysCommand,
  ListUserPoliciesCommand,
} from "@aws-sdk/client-iam";
import { defaultProvider } from "@aws-sdk/credential-provider-node"; // Correct import for default provider
import { CheckoutSessionID, DiskTypeEnum, JobRunID, OfferID, RedeemDiskGiftCard_BTOA } from "@officexapp/types";
import { CustomerPurchaseID } from "../../types/core.types"; // Assuming this path is correct based on your database.ts
import { LOCAL_DEV_MODE, vendor_customer_dashboard } from "../../constants";

/**
 * Interface for tracking AWS S3 storage resources and associated IAM credentials
 * for a specific gift card or customer purchase.
 * This setup uses a dedicated IAM User with a directly attached policy for S3 owner access.
 */
export interface AmazonS3StorageGiftcard extends Record<string, any> {
  // Using Record<string, any> for ExternalPayload
  external_id: string; // Renamed from ExternalID for direct string type
  arn_s3_bucket: string;
  iam_user_name: string;
  arn_iam_user: string;
  iam_policy_name: string;
  disk_auth_json: string; // json string
  officex_purchase_id: JobRunID;
  purchase_id: CustomerPurchaseID;
  offer_id: OfferID;
  checkout_session_id: CheckoutSessionID;
  redeem_url: string;
}

export interface AWSCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken?: string; // Optional for temporary credentials
}

export class AwsService {
  private s3Client: S3Client;
  private iamClient: IAMClient;
  private region: string;

  constructor(awsRegion: string) {
    this.region = awsRegion;

    // Initialize clients using the default credential provider chain (environment variables, shared config, EC2 instance metadata)
    // For production, consider using IAM roles for EC2 instances or ECS tasks for better security.
    this.s3Client = new S3Client({
      region: this.region,
      credentials: defaultProvider(), // Correct usage of defaultProvider
    });
    this.iamClient = new IAMClient({
      region: this.region,
      credentials: defaultProvider(), // Correct usage of defaultProvider
    });
  }

  /**
   * Deploys a new S3 bucket, creates a dedicated IAM user with administrative privileges
   * on that bucket, and generates access keys for the user.
   * @param bucketName The desired name for the S3 bucket.
   * @param iamUserName The desired name for the IAM user.
   * @param policyName The desired name for the IAM policy.
   * @param purchaseDetails Details to associate with the S3 storage record.
   * @returns AmazonS3StorageGiftcard object with details of the deployed resources.
   */
  public async deployNewS3Bucket(
    bucketName: string,
    iamUserName: string,
    policyName: string,
    purchaseDetails: {
      officex_purchase_id: JobRunID;
      purchase_id: CustomerPurchaseID;
      offer_id: OfferID;
      checkout_session_id: CheckoutSessionID;
    },
  ): Promise<AmazonS3StorageGiftcard> {
    console.log(`[AWS Service] Initiating deployment for bucket: ${bucketName}`);

    let bucketArn: string | undefined;
    let userArn: string | undefined;
    let accessKey: AWSCredentials | undefined;

    try {
      // 1. Create S3 Bucket
      await this.createS3Bucket(bucketName, purchaseDetails.purchase_id);
      bucketArn = `arn:aws:s3:::${bucketName}`;
      console.log(`[AWS Service] S3 Bucket '${bucketName}' created.`);

      // 2. Apply CORS policy to the S3 bucket
      await this.putBucketCORS(bucketName); // <--- Add this call
      console.log(`[AWS Service] CORS policy applied to bucket '${bucketName}'.`);

      // 3. Create IAM User
      // Correctly capture the output from createIamUser
      const userResult = await this.createIamUser(iamUserName);
      userArn = userResult.User?.Arn; // 'User' property now correctly accessed
      console.log(`[AWS Service] IAM User '${iamUserName}' created.`);

      // 4. Create IAM Access Key for the user
      accessKey = await this.createIamAccessKey(iamUserName);
      console.log(`[AWS Service] Access Key created for user '${iamUserName}'.`);

      // 5. Create and attach S3 admin policy to the IAM user
      if (!userArn) {
        throw new Error("IAM User ARN is undefined. Cannot attach policy.");
      }
      await this.createAndAttachS3AdminPolicy(iamUserName, policyName, bucketName);
      console.log(`[AWS Service] Policy '${policyName}' attached to user '${iamUserName}'.`);

      const diskAuthJson = {
        endpoint: "https://s3.amazonaws.com",
        access_key: accessKey.AccessKeyId,
        secret_key: accessKey.SecretAccessKey,
        bucket: bucketName,
        region: this.region,
      };

      // Construct the gift card parameters from form values
      const giftParams: RedeemDiskGiftCard_BTOA = {
        name: `Amazon Storage ${process.env.VENDOR_NAME}`,
        disk_type: DiskTypeEnum.AwsBucket,
        public_note: `Amazon S3 Storage Giftcard from "${process.env.VENDOR_NAME}"`,
        auth_json: JSON.stringify(diskAuthJson),
        endpoint: vendor_customer_dashboard,
      };

      // Generate the URL
      const redeem_url = this.generateRedeemDiskGiftCardURL(giftParams);

      return {
        external_id: iamUserName, // Using IAM username as external_id for simplicity
        arn_s3_bucket: bucketArn,
        iam_user_name: iamUserName,
        arn_iam_user: userArn,
        iam_policy_name: policyName,
        disk_auth_json: JSON.stringify(diskAuthJson),
        officex_purchase_id: purchaseDetails.officex_purchase_id,
        purchase_id: purchaseDetails.purchase_id,
        offer_id: purchaseDetails.offer_id,
        checkout_session_id: purchaseDetails.checkout_session_id,
        redeem_url,
      };
    } catch (error) {
      console.error(`[AWS Service] Error deploying S3 bucket and IAM resources:`, error);
      // Attempt to clean up partially created resources in case of failure
      await this.cleanupFailedDeployment(bucketName, iamUserName, policyName);
      throw error;
    }
  }

  /**
   * Destroys an S3 bucket and its associated IAM user and policies.
   * This includes emptying the bucket before deletion.
   * @param bucketName The name of the S3 bucket to destroy.
   * @param iamUserName The name of the IAM user associated with the bucket.
   * @param policyName The name of the IAM policy associated with the user.
   */
  public async destroyS3Bucket(bucketName: string, iamUserName: string, policyName: string): Promise<void> {
    console.log(`[AWS Service] Initiating destruction for bucket: ${bucketName}`);
    try {
      // 1. Delete IAM user's inline policies
      await this.deleteIamUserPolicies(iamUserName);
      console.log(`[AWS Service] Inline policies for user '${iamUserName}' deleted.`);

      // 2. Delete IAM Access Keys for the user
      await this.deleteIamAccessKeys(iamUserName);
      console.log(`[AWS Service] Access Keys for user '${iamUserName}' deleted.`);

      // 3. Delete IAM user
      await this.deleteIamUser(iamUserName);
      console.log(`[AWS Service] IAM User '${iamUserName}' deleted.`);

      // 4. Empty and delete S3 Bucket
      await this.emptyS3Bucket(bucketName);
      await this.deleteS3Bucket(bucketName);
      console.log(`[AWS Service] S3 Bucket '${bucketName}' and its contents deleted.`);

      console.log(`[AWS Service] All resources for '${bucketName}' successfully destroyed.`);
    } catch (error) {
      console.error(`[AWS Service] Error destroying S3 bucket and IAM resources for bucket '${bucketName}':`, error);
      throw error;
    }
  }

  // --- Private Helper Methods ---

  private async createS3Bucket(bucketName: string, purchaseID: CustomerPurchaseID): Promise<void> {
    const createBucketConfig: any = {
      Tags: [
        {
          Key: "officex_vendor_purchase_id",
          Value: purchaseID,
        },
      ],
    };

    // Edge case: us-east-1 region does not require LocationConstraint
    if (this.region !== "us-east-1") {
      createBucketConfig.CreateBucketConfiguration = {
        LocationConstraint: this.region as BucketLocationConstraint,
      };
    }

    const command = new CreateBucketCommand({
      Bucket: bucketName,
      ...createBucketConfig,
    });

    await this.s3Client.send(command);
    console.log(`[AWS Service] S3 Bucket '${bucketName}' created in region '${this.region}'.`);
  }

  private async putBucketCORS(bucketName: string): Promise<void> {
    const corsConfiguration = {
      CORSRules: [
        {
          AllowedHeaders: ["*"], // Allow all headers
          AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"], // Allow common methods
          AllowedOrigins: ["*"], // Allow requests from any origin
          ExposeHeaders: [], // No specific headers exposed
          MaxAgeSeconds: 3000, // How long the preflight request can be cached
        },
      ],
    };

    const command = new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: corsConfiguration,
    });

    await this.s3Client.send(command);
  }

  private async deleteS3Bucket(bucketName: string): Promise<void> {
    const command = new DeleteBucketCommand({
      Bucket: bucketName,
    });
    await this.s3Client.send(command);
  }

  private async emptyS3Bucket(bucketName: string): Promise<void> {
    console.log(`[AWS Service] Checking and emptying bucket '${bucketName}'...`);

    // 1. Delete all objects (current and non-current versions handled by S3 automatically on DeleteObjectsCommand)
    try {
      const paginator = paginateListObjectsV2(
        { client: this.s3Client }, // Pass your s3Client instance
        { Bucket: bucketName },
      );

      const objectKeysToDelete = [];
      for await (const page of paginator) {
        if (page.Contents) {
          objectKeysToDelete.push(...page.Contents.map((obj) => ({ Key: obj.Key })));
        }
      }

      if (objectKeysToDelete.length > 0) {
        // DeleteObjectsCommand can handle up to 1000 objects per request.
        // The paginator collects them all, so we might need to batch this if objectKeysToDelete is huge.
        // For simplicity, assuming objectKeysToDelete fits within 1000 or the API handles larger arrays internally by splitting (it doesn't usually).
        // A more robust solution for extremely large numbers of objects:
        const BATCH_SIZE = 1000;
        for (let i = 0; i < objectKeysToDelete.length; i += BATCH_SIZE) {
          const batch = objectKeysToDelete.slice(i, i + BATCH_SIZE);
          const deleteCommand = new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: batch, Quiet: true },
          });
          await this.s3Client.send(deleteCommand);
          console.log(`[AWS Service] Deleted batch of ${batch.length} objects from bucket '${bucketName}'.`);
        }
      } else {
        console.log(`[AWS Service] No objects to delete in bucket '${bucketName}'.`);
      }
    } catch (error) {
      console.error(`[AWS Service] Error deleting objects from bucket '${bucketName}':`, error);
      throw error; // Re-throw to indicate failure
    }

    // 2. Abort all incomplete multipart uploads (important for billing)
    let isTruncatedUploads = true;
    let keyMarkerUploads: string | undefined;
    let uploadIdMarkerUploads: string | undefined;

    do {
      const listMultipartUploadsCommand = new ListMultipartUploadsCommand({
        Bucket: bucketName,
        KeyMarker: keyMarkerUploads,
        UploadIdMarker: uploadIdMarkerUploads,
      });
      const { Uploads, NextKeyMarker, NextUploadIdMarker, IsTruncated } =
        await this.s3Client.send(listMultipartUploadsCommand);

      if (Uploads && Uploads.length > 0) {
        for (const upload of Uploads) {
          if (upload.Key && upload.UploadId) {
            const abortMultipartUploadCommand = new AbortMultipartUploadCommand({
              Bucket: bucketName,
              Key: upload.Key,
              UploadId: upload.UploadId,
            });
            try {
              await this.s3Client.send(abortMultipartUploadCommand);
              // console.log(`[AWS Service] Aborted incomplete multipart upload for key '${upload.Key}' with ID '${upload.UploadId}'.`); // Too verbose perhaps
            } catch (abortError) {
              console.warn(`[AWS Service] Failed to abort multipart upload for key '${upload.Key}':`, abortError);
            }
          }
        }
      } else {
        console.log(`[AWS Service] No more incomplete multipart uploads to abort in bucket '${bucketName}'.`);
      }

      keyMarkerUploads = NextKeyMarker;
      uploadIdMarkerUploads = NextUploadIdMarker;
      isTruncatedUploads = IsTruncated || false;
    } while (isTruncatedUploads);

    console.log(
      `[AWS Service] Bucket '${bucketName}' is now completely empty (objects and incomplete multipart uploads). But the bucket still exists, you can delete it manually if you want to.`,
    );
  }

  // Corrected return type for createIamUser
  private async createIamUser(userName: string): Promise<CreateUserCommandOutput> {
    const command = new CreateUserCommand({
      UserName: userName,
    });
    return this.iamClient.send(command);
  }

  private async deleteIamUser(userName: string): Promise<void> {
    const command = new DeleteUserCommand({
      UserName: userName,
    });
    await this.iamClient.send(command);
  }

  private async createIamAccessKey(userName: string): Promise<AWSCredentials> {
    const command = new CreateAccessKeyCommand({
      UserName: userName,
    });
    const result = await this.iamClient.send(command);
    if (!result.AccessKey?.AccessKeyId || !result.AccessKey?.SecretAccessKey) {
      throw new Error("Failed to create IAM Access Key.");
    }
    return {
      AccessKeyId: result.AccessKey.AccessKeyId,
      SecretAccessKey: result.AccessKey.SecretAccessKey,
    };
  }

  private async deleteIamAccessKeys(userName: string): Promise<void> {
    const listCommand = new ListAccessKeysCommand({ UserName: userName });
    const { AccessKeyMetadata } = await this.iamClient.send(listCommand);

    if (AccessKeyMetadata) {
      for (const key of AccessKeyMetadata) {
        if (key.AccessKeyId) {
          const deleteCommand = new DeleteAccessKeyCommand({
            AccessKeyId: key.AccessKeyId,
            UserName: userName,
          });
          await this.iamClient.send(deleteCommand);
        }
      }
    }
  }

  private async createAndAttachS3AdminPolicy(userName: string, policyName: string, bucketName: string): Promise<void> {
    const policyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketPolicy"],
          Resource: [`arn:aws:s3:::${bucketName}`],
        },
        {
          Effect: "Allow",
          Action: "s3:*Object", // Grants permissions for all object-level operations
          Resource: [`arn:aws:s3:::${bucketName}/*`],
        },
      ],
    };

    // Note: This creates an *inline* policy directly attached to the user.
    // For more robust solutions, consider creating a *managed* policy and then attaching it.
    const command = new PutUserPolicyCommand({
      UserName: userName,
      PolicyName: policyName,
      PolicyDocument: JSON.stringify(policyDocument),
    });
    await this.iamClient.send(command);
  }

  private async deleteIamUserPolicies(userName: string): Promise<void> {
    const listCommand = new ListUserPoliciesCommand({ UserName: userName });
    const { PolicyNames } = await this.iamClient.send(listCommand);

    if (PolicyNames) {
      for (const policyName of PolicyNames) {
        const deleteCommand = new DeleteUserPolicyCommand({
          UserName: userName,
          PolicyName: policyName,
        });
        await this.iamClient.send(deleteCommand);
      }
    }
  }

  /**
   * Attempts to clean up resources if deployment fails mid-way.
   * This is a best-effort cleanup and might not cover all edge cases.
   */
  private async cleanupFailedDeployment(bucketName: string, iamUserName: string, policyName: string): Promise<void> {
    console.warn(`[AWS Service] Attempting cleanup for failed deployment for bucket: ${bucketName}`);
    try {
      // Try to delete policies
      try {
        await this.deleteIamUserPolicies(iamUserName);
      } catch (err) {
        console.warn(`[AWS Service] Could not delete IAM user policies for '${iamUserName}' during cleanup:`, err);
      }

      // Try to delete access keys
      try {
        await this.deleteIamAccessKeys(iamUserName);
      } catch (err) {
        console.warn(`[AWS Service] Could not delete IAM access keys for '${iamUserName}' during cleanup:`, err);
      }

      // Try to delete the IAM user
      try {
        await this.deleteIamUser(iamUserName);
      } catch (err) {
        console.warn(`[AWS Service] Could not delete IAM user '${iamUserName}' during cleanup:`, err);
      }

      // Try to empty and delete the S3 bucket
      try {
        await this.emptyS3Bucket(bucketName);
        await this.deleteS3Bucket(bucketName);
      } catch (err) {
        console.warn(`[AWS Service] Could not empty or delete S3 bucket '${bucketName}' during cleanup:`, err);
      }
    } catch (cleanupError) {
      console.error(`[AWS Service] Error during cleanup of failed deployment:`, cleanupError);
    }
  }

  // Export the helper function to generate redemption URLs
  private generateRedeemDiskGiftCardURL({
    name,
    disk_type,
    public_note,
    auth_json,
    endpoint,
  }: RedeemDiskGiftCard_BTOA) {
    const payload: RedeemDiskGiftCard_BTOA = {
      name,
      disk_type,
      public_note,
      auth_json,
      endpoint,
    };
    const origin = LOCAL_DEV_MODE ? `http://localhost:5173` : `https://officex.app`;
    const finalUrl = `${origin}/org/current/redeem/disk-giftcard?redeem=${urlSafeBase64Encode(JSON.stringify(payload))}`;
    return finalUrl;
  }
}

// Encode: Direct URL-safe Base64
export function urlSafeBase64Encode(str: string) {
  // Handle Unicode characters
  const utf8Bytes = new TextEncoder().encode(str);
  const binaryString = Array.from(utf8Bytes)
    .map((byte) => String.fromCharCode(byte))
    .join("");

  // Standard Base64 encoding
  const base64 = btoa(binaryString);

  // Make URL-safe by replacing characters
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
