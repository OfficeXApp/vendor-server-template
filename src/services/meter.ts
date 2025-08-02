// src/services/meter.ts
import { DatabaseService } from "./database";
import { CustomerPurchaseID, UsageRecord, HistoricalBillingEntry } from "../types/core.types";

/**
 * Service for handling metering operations, including recording usage and retrieving historical billing data.
 * This service abstracts the direct database interactions for metering logic.
 */
export class MeterService {
  private db: DatabaseService;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService;
  }

  /**
   * Records a new usage event and deducts the incurred cost from the customer's balance.
   * This operation is transactional at the database level (handled by DatabaseService).
   *
   * @param purchase_id The ID of the customer purchase.
   * @param usage_amount The quantity of usage (e.g., GB, API calls).
   * @param unit The unit of usage (e.g., 'GB', 'API_CALLS').
   * @param cost_incurred The cost deducted for this specific usage event.
   * @param description Optional: Description of the usage event.
   * @param metadata Optional: Additional JSON metadata for the usage.
   * @returns The newly created UsageRecord.
   * @throws Error if the operation fails (e.g., database error, purchase not found).
   */
  public async recordUsage(record: UsageRecord): Promise<UsageRecord> {
    // The database service handles the atomic insertion and balance deduction,
    // including trigger checks and warnings.
    const createdRecord = await this.db.addUsageRecordAndDeductBalance(record);

    return createdRecord;
  }

  /**
   * Retrieves historical billing data for a specific purchase, aggregated by time bucket.
   *
   * @param purchase_id The ID of the customer purchase.
   * @param interval The time interval for aggregation (e.g., 'daily', 'hourly', 'weekly').
   *                 'daily' will be mapped to '1 day' for TimescaleDB.
   * @param startDate Optional: Start date for the historical data.
   * @param endDate Optional: End date for the historical data.
   * @returns An array of aggregated HistoricalBillingEntry objects.
   * @throws Error if the database operation fails.
   */
  public async getHistoricalBillingReport(
    purchase_id: CustomerPurchaseID,
    interval: string = "daily", // Default to daily
    startDate?: Date,
    endDate?: Date,
  ): Promise<HistoricalBillingEntry[]> {
    // Map common interval names to TimescaleDB compatible strings
    let dbInterval: string;
    switch (interval.toLowerCase()) {
      case "daily":
        dbInterval = "1 day";
        break;
      case "hourly":
        dbInterval = "1 hour";
        break;
      case "weekly":
        dbInterval = "1 week";
        break;
      case "monthly":
        dbInterval = "1 month";
        break;
      case "yearly":
        dbInterval = "1 year";
        break;
      default:
        // Allow direct pass-through for TimescaleDB specific intervals like '5 minutes'
        // or throw an error if you want to restrict intervals.
        dbInterval = interval;
        break;
    }

    const history = await this.db.getHistoricalBilling(purchase_id, dbInterval, startDate, endDate);

    // The handler will be responsible for formatting the timestamp for the response.
    return history;
  }
}

export const alertVendorError = async (message: string) => {
  console.error(message);
  // this should send an alert to the vendor
};
