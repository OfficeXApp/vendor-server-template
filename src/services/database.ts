// src/services/database.ts
import { Pool, QueryResult, QueryResultRow } from "pg";
import {
  Offer,
  CheckoutWallet,
  CustomerPurchase,
  OfferID,
  CustomerPurchaseID,
  CheckoutWalletID,
  UsageRecord,
  HistoricalBillingEntry,
} from "../types/core.types"; // Adjust path as needed
import { CheckoutSessionID } from "@officexapp/types";
import path from "path";
import fs from "fs";

export class DatabaseService {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      // You might want to add more pool options here, e.g., max, idleTimeoutMillis
    });

    // Optional: Log pool events for debugging
    this.pool.on("error", (err: Error) => {
      console.error("Unexpected error on idle client", err);
      process.exit(-1); // Exit process if a client in the pool has an unrecoverable error
    });
  }

  /**
   * Connects to the database and performs a simple query to verify connection.
   */
  public async connect(): Promise<void> {
    try {
      await this.pool.query("SELECT 1+1 AS result");
      console.log("Database connected successfully.");
    } catch (error) {
      console.error("Failed to connect to database:", error);
      throw error; // Re-throw to indicate connection failure
    }
  }

  /**
   * Disconnects all clients from the database pool.
   */
  public async disconnect(): Promise<void> {
    await this.pool.end();
    console.log("Database pool disconnected.");
  }

  /**
   * Executes a raw SQL query. Use with caution.
   * @param text The SQL query string.
   * @param params Optional array of query parameters.
   * @returns The query result.
   */
  public async query<T extends QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  public async runDatabaseMigrations(): Promise<void> {
    const migrationsPath = path.join(__dirname, "..", "schema", "migrations");
    let client;

    try {
      client = await this.pool.connect();
      await client.query("BEGIN");

      // Check if the _migrations table exists.
      const tableCheckQuery =
        "SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = '_migrations');";
      const tableCheckResult = await client.query(tableCheckQuery);
      const migrationsTableExists = tableCheckResult.rows[0].exists;

      // If the migrations table doesn't exist, assume a brand new database
      // and apply the full schema from the 'schema.sql' file.
      if (!migrationsTableExists) {
        console.log("Database is new. Applying full schema from 'schema.sql'...");
        const fullSchemaPath = path.join(__dirname, "..", "schema", "schema.sql");
        const fullSchemaSql = fs.readFileSync(fullSchemaPath, "utf8");
        await client.query(fullSchemaSql);

        // Record the initial schema application in the _migrations table
        await client.query("INSERT INTO _migrations (name) VALUES ($1);", ["schema.sql"]);
        console.log("Full schema applied successfully.");
      }

      // Now, get the list of already applied migrations from the migrations directory.
      const appliedMigrationsResult = await client.query("SELECT name FROM _migrations;");
      const appliedMigrations = new Set(appliedMigrationsResult.rows.map((row) => row.name));

      // Find and apply new, incremental migration files.
      const files = fs.readdirSync(migrationsPath).sort();
      console.log(`Found ${files.length} migration files. Applying new ones...`);

      for (const file of files) {
        if (file.endsWith(".sql") && !appliedMigrations.has(file)) {
          const filePath = path.join(migrationsPath, file);
          const sql = fs.readFileSync(filePath, "utf8");
          console.log(`Applying incremental migration: ${file}`);
          await client.query(sql);
          // Insert the filename into the _migrations table to mark it as applied
          await client.query("INSERT INTO _migrations (name) VALUES ($1);", [file]);
        }
      }

      await client.query("COMMIT");
      console.log("All pending database migrations applied successfully. ✅");
    } catch (error) {
      console.error("Failed to apply database migrations:", error);
      if (client) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  // --- Offer CRUD Operations ---

  public async createOffer(offer: Offer): Promise<Offer> {
    const query = `
      INSERT INTO offers (id, sku, title, description, created_at, updated_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const values = [
      offer.id,
      offer.sku,
      offer.title,
      offer.description,
      offer.created_at,
      offer.updated_at,
      offer.metadata ? JSON.stringify(offer.metadata) : null,
    ];
    const result = await this.query<Offer>(query, values);
    return result.rows[0];
  }

  public async getOfferById(id: OfferID): Promise<Offer | null> {
    const query = "SELECT * FROM offers WHERE id = $1;";
    const result = await this.query<Offer>(query, [id]);
    return result.rows[0] || null;
  }

  public async listOffers(): Promise<Offer[]> {
    const query = "SELECT * FROM offers ORDER BY created_at DESC;";
    const result = await this.query<Offer>(query);
    return result.rows;
  }

  // --- CheckoutWallet CRUD Operations ---

  public async createCheckoutWallet(wallet: CheckoutWallet): Promise<CheckoutWallet> {
    const query = `
      INSERT INTO checkout_wallets (
        id, title, description, evm_address, private_key, seed_phrase,
        latest_usd_balance, created_at, updated_at, tracer, metadata,
        purchase_id, offramp_evm_address, offer_id, checkout_flow_id, checkout_session_id, email,
        user_id, org_id, org_host
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *;
    `;
    const values = [
      wallet.id,
      wallet.title,
      wallet.description,
      wallet.evm_address,
      wallet.private_key,
      wallet.seed_phrase,
      wallet.latest_usd_balance,
      wallet.created_at,
      wallet.updated_at,
      wallet.tracer,
      wallet.metadata,
      wallet.purchase_id,
      wallet.offramp_evm_address,
      wallet.offer_id,
      wallet.checkout_flow_id,
      wallet.checkout_session_id,
      wallet.email,
      wallet.user_id,
      wallet.org_id,
      wallet.org_host,
    ];
    const result = await this.query<CheckoutWallet>(query, values);
    return result.rows[0];
  }

  public async getCheckoutWalletById(id: CheckoutWalletID): Promise<CheckoutWallet | null> {
    const query = "SELECT * FROM checkout_wallets WHERE id = $1;";
    const result = await this.query<CheckoutWallet>(query, [id]);
    return result.rows[0] || null;
  }

  public async getCheckoutWalletByCheckoutSessionID(
    checkout_session_id: CheckoutSessionID,
  ): Promise<CheckoutWallet | null> {
    const query = "SELECT * FROM checkout_wallets WHERE checkout_session_id = $1;";
    const result = await this.query<CheckoutWallet>(query, [checkout_session_id]);
    return result.rows[0] || null;
  }

  public async getCheckoutWalletByPurchaseId(purchase_id: CustomerPurchaseID): Promise<CheckoutWallet | null> {
    const query = "SELECT * FROM checkout_wallets WHERE purchase_id = $1;";
    const result = await this.query<CheckoutWallet>(query, [purchase_id]);
    return result.rows[0] || null;
  }

  public async updateCheckoutWallet(
    id: CheckoutWalletID,
    updates: Partial<CheckoutWallet>,
  ): Promise<CheckoutWallet | null> {
    const updateFields: string[] = [];
    const updateValues: any[] = [id]; // $1 is for the ID in WHERE clause

    // Collect fields and values from the `updates` object
    Object.keys(updates).forEach((key) => {
      // Start parameters from $2 for the SET clause
      updateFields.push(`${key} = $${updateValues.length + 1}`);
      updateValues.push((updates as any)[key]);
    });

    // Ensure updated_at is always updated, unless explicitly provided in `updates`
    if (!updates.updated_at) {
      updateFields.push(`updated_at = $${updateValues.length + 1}`);
      updateValues.push(Date.now());
    }

    // If no fields to update (e.g., `updates` was empty and `updated_at` was just added),
    // `updateFields` will contain at least `updated_at`.
    // This check is primarily for defensive programming, though `updateFields.length`
    // should always be >= 1 after the `updated_at` logic.
    if (updateFields.length === 0) {
      return this.getCheckoutWalletById(id); // No actual update to perform
    }

    const query = `
      UPDATE checkout_wallets
      SET ${updateFields.join(", ")}
      WHERE id = $1
      RETURNING *;
    `;
    const result = await this.query<CheckoutWallet>(query, updateValues);
    return result.rows[0] || null;
  }

  // --- CustomerPurchase CRUD Operations ---

  public async createCustomerPurchase(purchase: CustomerPurchase): Promise<CustomerPurchase> {
    const query = `
      INSERT INTO customer_purchases (
        id, wallet_id, checkout_session_id, officex_purchase_id, title, description,
        customer_user_id, customer_org_id, customer_org_host,
        vendor_id, price_line, customer_billing_api_key, vendor_billing_api_key,
        vendor_notes, balance_low_trigger, balance_critical_trigger,
        balance_termination_trigger, created_at, updated_at, tracer, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING *;
    `;
    const values = [
      purchase.id,
      purchase.wallet_id,
      purchase.checkout_session_id,
      purchase.officex_purchase_id,
      purchase.title,
      purchase.description,
      purchase.customer_user_id,
      purchase.customer_org_id,
      purchase.customer_org_host,
      purchase.vendor_id,
      purchase.price_line,
      purchase.customer_billing_api_key,
      purchase.vendor_billing_api_key,
      purchase.vendor_notes,
      purchase.balance_low_trigger,
      purchase.balance_critical_trigger,
      purchase.balance_termination_trigger,
      purchase.created_at,
      purchase.updated_at,
      purchase.tracer,
      purchase.metadata,
    ];
    const result = await this.query<CustomerPurchase>(query, values);
    return result.rows[0];
  }

  public async getCustomerPurchaseById(id: CustomerPurchaseID): Promise<CustomerPurchase | null> {
    const query = "SELECT * FROM customer_purchases WHERE id = $1;";
    const result = await this.query<CustomerPurchase>(query, [id]);
    return result.rows[0] || null;
  }
  public async getCustomerPurchaseByCheckoutSessionID(
    checkout_session_id: CheckoutSessionID,
  ): Promise<CustomerPurchase | null> {
    const query = "SELECT * FROM customer_purchases WHERE checkout_session_id = $1;";
    const result = await this.query<CustomerPurchase>(query, [checkout_session_id]);
    return result.rows[0] || null;
  }

  public async updateCustomerPurchase(
    id: CustomerPurchaseID,
    updates: Partial<CustomerPurchase>,
  ): Promise<CustomerPurchase | null> {
    const fields = Object.keys(updates)
      .map((key, index) => `${key} = $${index + 2}`) // Start params from $2 as $1 is id
      .join(", ");
    const values = [id, ...Object.values(updates)];

    if (Object.keys(updates).length === 0) {
      return this.getCustomerPurchaseById(id); // No updates to perform
    }

    // Ensure updated_at is always updated
    if (!updates.updated_at) {
      fields + `, updated_at = $${values.length + 1}`;
      values.push(Date.now());
    }

    const query = `
      UPDATE customer_purchases
      SET ${fields}
      WHERE id = $1
      RETURNING *;
    `;
    const result = await this.query<CustomerPurchase>(query, values);
    return result.rows[0] || null;
  }

  // --- UsageRecord (Hypertable) Operations ---

  /**
   * Adds a new usage record and updates the customer's balance.
   * This operation should be atomic (transactional).
   * @param usage The usage record to insert.
   * @returns The inserted UsageRecord.
   */
  public async addUsageRecordAndDeductBalance(usage: UsageRecord): Promise<UsageRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Insert the usage record
      const insertQuery = `
        INSERT INTO usage_records (
          purchase_id, timestamp, usage_amount, usage_unit, billed_amount, description, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
      `;
      const insertValues = [
        usage.purchase_id,
        usage.timestamp, // pg client handles Date objects for TIMESTAMPTZ
        usage.usage_amount,
        usage.usage_unit,
        usage.billed_amount,
        usage.description,
        usage.metadata,
      ];
      const usageResult = await client.query<UsageRecord>(insertQuery, insertValues);
      const newUsageRecord = usageResult.rows[0];

      // fetch the wallet
      const wallet = await this.getCheckoutWalletByPurchaseId(usage.purchase_id);

      if (!wallet) {
        throw new Error(`Wallet with Purchase ID ${usage.purchase_id} not found for balance update.`);
      }

      const purchase = await this.getCustomerPurchaseById(usage.purchase_id);

      if (!purchase) {
        throw new Error(`Customer purchase with ID ${usage.purchase_id} not found for balance update.`);
      }

      // 2. Deduct the cost from the wallet's balance
      const updateBalanceQuery = `
        UPDATE checkout_wallets
        SET
          latest_usd_balance = latest_usd_balance - $2,
          updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        WHERE id = $1
        RETURNING latest_usd_balance;
      `;
      const balanceResult = await client.query<CheckoutWallet>(updateBalanceQuery, [wallet.id, usage.billed_amount]);

      if (balanceResult.rows.length === 0) {
        throw new Error(`Customer purchase with ID ${usage.purchase_id} not found for balance update.`);
      }

      const { latest_usd_balance } = balanceResult.rows[0];

      const { balance_low_trigger, balance_critical_trigger, balance_termination_trigger } = purchase;

      // Optional: Add logic here to check balance triggers and send notifications
      if (latest_usd_balance <= balance_termination_trigger) {
        console.warn(
          `Purchase ${usage.purchase_id} balance is at or below termination trigger, current balance: ${latest_usd_balance}`,
        );
        // Trigger service termination logic
      } else if (latest_usd_balance <= balance_critical_trigger) {
        console.warn(
          `Purchase ${usage.purchase_id} balance is at or below critical trigger, current balance: ${latest_usd_balance}`,
        );
        // Trigger critical balance notification
      } else if (latest_usd_balance <= balance_low_trigger) {
        console.warn(
          `Purchase ${usage.purchase_id} balance is at or below low trigger, current balance: ${latest_usd_balance}`,
        );
        // Trigger low balance notification
      }

      await client.query("COMMIT");
      return newUsageRecord;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Transaction failed for addUsageRecordAndDeductBalance:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves historical billing data for a specific purchase, aggregated by time bucket.
   * Uses TimescaleDB's time_bucket function.
   * @param purchaseId The ID of the customer purchase.
   * @param interval The time interval for aggregation (e.g., '1 day', '1 hour').
   * @param startDate Optional: Start date for the historical data.
   * @param endDate Optional: End date for the historical data.
   * @returns An array of aggregated billing entries.
   */
  public async getHistoricalBilling(
    purchaseId: CustomerPurchaseID,
    interval: string, // e.g., '1 day', '1 hour', '1 week'
    startDate?: Date,
    endDate?: Date,
  ): Promise<HistoricalBillingEntry[]> {
    let query = `
      SELECT
        time_bucket($1, timestamp) AS time_bucket,
        SUM(usage_amount) AS total_usage_amount,
        SUM(cost_incurred) AS total_billed_amount,
        purchase_id
      FROM usage_records
      WHERE purchase_id = $2
    `;
    const values: any[] = [interval, purchaseId];
    let paramIndex = 3;

    if (startDate) {
      query += ` AND timestamp >= $${paramIndex++}`;
      values.push(startDate);
    }
    if (endDate) {
      query += ` AND timestamp <= $${paramIndex++}`;
      values.push(endDate);
    }

    query += `
      GROUP BY time_bucket, purchase_id
      ORDER BY time_bucket ASC;
    `;

    const result = await this.query<HistoricalBillingEntry>(query, values);
    return result.rows;
  }

  /**
   * Retrieves all usage records for a specific purchase within a time range.
   * @param purchaseId The ID of the customer purchase.
   * @param startDate Optional: Start date for the records.
   * @param endDate Optional: End date for the records.
   * @returns An array of UsageRecord objects.
   */
  public async getUsageRecordsByPurchaseId(
    purchaseId: CustomerPurchaseID,
    startDate?: Date,
    endDate?: Date,
  ): Promise<UsageRecord[]> {
    let query = `
      SELECT *
      FROM usage_records
      WHERE purchase_id = $1
    `;
    const values: any[] = [purchaseId];
    let paramIndex = 2;

    if (startDate) {
      query += ` AND timestamp >= $${paramIndex++}`;
      values.push(startDate);
    }
    if (endDate) {
      query += ` AND timestamp <= $${paramIndex++}`;
      values.push(endDate);
    }

    query += ` ORDER BY timestamp DESC;`;

    const result = await this.query<UsageRecord>(query, values);
    return result.rows;
  }
}
