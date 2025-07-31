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
  GetObjectCommand,
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
import { CustomerPurchaseID, UsageRecord } from "../../types/core.types"; // Assuming this path is correct based on your database.ts
import { LOCAL_DEV_MODE, vendor_customer_dashboard, vendor_server_endpoint } from "../../constants";
import * as fs from "fs";
import { parse } from "csv-parse";
import { DatabaseService } from "../database";
import * as zlib from "zlib";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { mkdir, readdir, unlink, rmdir } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import * as yauzl from "yauzl";

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

  /**
   * Downloads the latest AWS Cost and Usage Report manifest file and all
   * associated zipped CSV files to a local directory, then unzips them.
   * @returns An array of relative file paths to the unzipped CSV files.
   */
  public async downloadBillingExportFolder(date: Date): Promise<string[]> {
    console.log(`[AWS Service] Starting download of billing exports from S3...`);

    // 1. **Add this line to ensure the directory exists.**
    const localExportPath = "./billing-exports";
    try {
      await mkdir(localExportPath, { recursive: true });
      console.log(`[AWS Service] Ensured local directory '${localExportPath}' exists.`);
    } catch (err) {
      console.error(`[AWS Service] Failed to create local directory:`, err);
      throw err;
    }
    await this.cleanupBillingExportFolder(); // Ensure the folder is clean before starting

    const reportName = "officex-vendor-billing-report";
    const dateRange = getBillingPeriodRange(date);
    const manifestKey = `costreports/${reportName}/${dateRange}/${reportName}-Manifest.json`;

    console.log(`[AWS Service] Looking for manifest at key: ${manifestKey}`);

    // 1. Download the manifest file from the stable key
    const manifestCommand = new GetObjectCommand({
      Bucket: process.env.BILLING_BUCKET_NAME,
      Key: manifestKey,
    });

    let manifestData;
    try {
      const response = await this.s3Client.send(manifestCommand);
      manifestData = await response.Body?.transformToString();
    } catch (error) {
      console.error(`[AWS Service] Failed to download manifest file:`, error);
      throw new Error("Failed to download AWS billing manifest.");
    }

    if (!manifestData) {
      throw new Error("Manifest file is empty or could not be transformed.");
    }

    const manifest = JSON.parse(manifestData);
    // The `reportKeys` array from the manifest gives you the full, unstable paths
    const reportKeys = manifest.reportKeys as string[];
    const csvFilePaths: string[] = [];

    for (const reportKey of reportKeys) {
      const fileName = path.basename(reportKey);
      const localCsvPath = path.join(localExportPath, fileName.replace(/\.zip$/, ""));

      console.log(`[AWS Service] Downloading and unzipping: ${reportKey}`);

      const getObjectCommand = new GetObjectCommand({
        Bucket: process.env.BILLING_BUCKET_NAME,
        Key: reportKey,
      });

      try {
        const response = await this.s3Client.send(getObjectCommand);

        if (!response.Body) {
          console.warn(`[AWS Service] S3 object body is empty for key: ${reportKey}. Skipping.`);
          continue;
        }

        const contentLength = response.ContentLength;
        console.log(`[AWS Service] File size: ${contentLength} bytes. Attempting to decompress with yauzl.`);

        // Read the S3 stream into a buffer first
        const s3Stream = response.Body as Readable;
        const chunks = [];
        for await (const chunk of s3Stream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        // Decompress the zip file from the buffer using yauzl
        await new Promise<void>((resolve, reject) => {
          yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
            if (err) {
              return reject(err);
            }
            zipfile.on("entry", (entry) => {
              // Extract only the CSV file from the zip archive
              if (!entry.fileName.endsWith(".csv")) {
                zipfile.readEntry();
                return;
              }
              zipfile.openReadStream(entry, (err, readStream) => {
                if (err) {
                  return reject(err);
                }
                const writeStream = createWriteStream(localCsvPath);
                writeStream.on("finish", () => {
                  console.log(`[AWS Service] Successfully unzipped and saved: ${localCsvPath}`);
                  csvFilePaths.push(localCsvPath);
                  zipfile.readEntry(); // Read the next entry
                  resolve();
                });
                writeStream.on("error", reject);
                readStream.pipe(writeStream);
              });
            });
            zipfile.readEntry();
          });
        });
      } catch (error: any) {
        console.error(`[AWS Service] Failed to download or unzip ${reportKey}:`, error);
        console.error(`[AWS Service] Error details:`, error.stack);
      }
    }

    console.log(`[AWS Service] Finished downloading and unzipping all billing exports.`);
    return csvFilePaths;
  }

  /**
   * Deletes all files within the local billing-exports folder.
   * This function ensures the directory is empty before a new download.
   */
  public async cleanupBillingExportFolder(): Promise<void> {
    console.log(`[AWS Service] Cleaning up local billing exports folder: ${"./billing-exports"}`);
    try {
      const files = await readdir("./billing-exports");
      if (files.length === 0) {
        console.log(`[AWS Service] Folder is already empty.`);
        return;
      }

      for (const file of files) {
        const filePath = path.join("./billing-exports", file);
        await unlink(filePath);
        console.log(`[AWS Service] Deleted file: ${filePath}`);
      }

      // After deleting all files, you can optionally remove the directory itself
      // and re-create it on the next run, but just deleting the files is sufficient
      // for this use case.
      console.log(`[AWS Service] Successfully cleaned up the folder.`);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        console.log(`[AWS Service] Folder does not exist, no cleanup needed.`);
      } else {
        console.error(`[AWS Service] Failed to cleanup billing exports folder:`, error);
        throw error;
      }
    }
  }

  // Process the S3 billing file
  public async processS3BillingFile(filePath: string, db: DatabaseService): Promise<void> {
    console.log(`[AwsService] Starting to process S3 billing file: ${filePath}`);
    let processedRows = 0;

    try {
      const parser = fs.createReadStream(filePath).pipe(
        parse({
          columns: true,
          skip_empty_lines: true,
        }),
      );

      for await (const record of parser) {
        const resourceTag = record["resourceTags/user:officex_vendor_purchase_id"];

        if (resourceTag && resourceTag.startsWith("CustomerPurchaseID_")) {
          processedRows++;
          console.log(`[AwsService] Processing valid row for purchase ID: ${resourceTag}`);

          try {
            const purchaseId: CustomerPurchaseID = resourceTag;
            const customerPurchase = await db.getCustomerPurchaseById(purchaseId);

            if (!customerPurchase) {
              console.warn(`[AwsService] Customer purchase with ID ${purchaseId} not found. Skipping row.`);
              continue; // Skip this row and move to the next one
            }

            const vendorApiKey = customerPurchase.vendor_billing_api_key;
            const unitCost = parseFloat(record["lineItem/BlendedRate"]);
            const usageAmount = parseFloat(record["lineItem/UsageAmount"]);
            const billedCost = parseFloat(record["lineItem/BlendedCost"]);

            // Apply the 36% markup
            const billedAmountWithMarkup = billedCost * 1.36;

            const usageRecord: UsageRecord = {
              purchase_id: purchaseId,
              timestamp: new Date(record["bill/BillingPeriodStartDate"]),
              usage_amount: usageAmount,
              usage_unit: record["pricing/unit"],
              billed_amount: billedAmountWithMarkup,
              description: record["lineItem/LineItemDescription"],
            };

            await db.addUsageRecordAndDeductBalance(usageRecord);

            console.log(
              `[AwsService] Successfully metered usage for ${purchaseId}. Billed amount: ${billedAmountWithMarkup.toFixed(6)} USD.`,
            );
          } catch (rowError) {
            console.error(`[AwsService] Error processing row for purchase ID ${resourceTag}:`, rowError);
          }
        }
      }
      console.log(`[AwsService] Finished processing billing file. Processed ${processedRows} valid rows.`);
    } catch (fileError) {
      console.error(`[AwsService] Failed to process billing file:`, fileError);
      throw fileError;
    }
  }

  public async runDailyBillingJob(db: DatabaseService, date: Date): Promise<void> {
    console.log(`[AWS Service] Initiating daily billing job...`);
    try {
      // 1. Download the latest billing report files
      const csvFilePaths = await this.downloadBillingExportFolder(date);
      console.log(`[AWS Service] Found and downloaded ${csvFilePaths.length} CSV files.`);

      // 2. Loop through the downloaded files and process each one
      for (const filePath of csvFilePaths) {
        await this.processS3BillingFile(filePath, db);
      }

      // 3. Clean up the local folder after processing
      await this.cleanupBillingExportFolder();
      console.log(`[AWS Service] Daily billing job completed successfully. 🎉`);
    } catch (error) {
      console.error(`[AWS Service] Daily billing job failed:`, error);
      // It's good practice to ensure cleanup happens even on error
      try {
        await this.cleanupBillingExportFolder();
      } catch (cleanupError) {
        console.error(`[AWS Service] Cleanup after failure also failed:`, cleanupError);
      }
      throw error;
    }
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

// this function returns the previous days month range, since cron job is expected to run at 3:00 AM UTC
export const getBillingPeriodRange = (date: Date) => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  const startDate = new Date(Date.UTC(year, month, 1));
  const endDate = new Date(Date.UTC(year, month + 1, 1));

  const format = (d: Date) => {
    const y = d.getUTCFullYear();
    const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const day = d.getUTCDate().toString().padStart(2, "0");
    return `${y}${m}${day}`;
  };

  const startFormatted = format(startDate);
  const endFormatted = format(endDate);

  return `${startFormatted}-${endFormatted}`;
};

const getFormattedTimestamp = () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = now.getUTCDate().toString().padStart(2, "0");
  const hours = now.getUTCHours().toString().padStart(2, "0");
  const minutes = now.getUTCMinutes().toString().padStart(2, "0");
  const seconds = now.getUTCSeconds().toString().padStart(2, "0");

  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
};
