-- schema.sql

-- Enable the TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Set the time zone for the session to UTC for consistency
SET TIME ZONE 'UTC';

-- Drop tables in reverse order of dependency to allow recreation during development
DROP TABLE IF EXISTS usage_records;
DROP TABLE IF EXISTS customer_purchases;
DROP TABLE IF EXISTS deposit_wallets;
DROP TABLE IF EXISTS offers;

-- Table for Offers
-- Represents the products or services available for purchase (e.g., Amazon S3, Gemini API Key)
CREATE TABLE offers (
    id TEXT PRIMARY KEY, -- Corresponds to OfferSKU enum values (e.g., 'AmazonS3Disk_01')
    sku TEXT NOT NULL UNIQUE, -- Redundant if id is SKU, but good for clarity/indexing
    title VARCHAR(255) NOT NULL,
    description TEXT,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT, -- Unix timestamp in milliseconds
    updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT, -- Unix timestamp in milliseconds
    metadata JSONB -- Flexible JSON storage for additional offer details
);

COMMENT ON TABLE offers IS 'Defines the types of products/services offered by the vendor.';
COMMENT ON COLUMN offers.id IS 'Unique identifier for the offer, typically matching OfferSKU.';
COMMENT ON COLUMN offers.sku IS 'Stock Keeping Unit for the offer.';
COMMENT ON COLUMN offers.metadata IS 'Additional JSON metadata for the offer.';


-- Table for Deposit Wallets
-- Stores details of cryptocurrency deposit wallets created for customer checkouts.
-- These can exist before a purchase is finalized.
CREATE TABLE deposit_wallets (
    id TEXT PRIMARY KEY, -- Unique identifier for the deposit wallet (e.g., 'DepositWallet_...')
    title VARCHAR(255) NOT NULL,
    description TEXT,
    evm_address VARCHAR(42) NOT NULL UNIQUE, -- Ethereum Virtual Machine address (e.g., 0x...)
    private_key TEXT NOT NULL, -- WARNING: Sensitive data. Should be encrypted at rest in production.
    seed_phrase TEXT, -- WARNING: Even more sensitive. Should be encrypted at rest in production.
    latest_usd_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000, -- Current balance in USD, 6 decimal places
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    tracer TEXT, -- Optional tracing identifier
    metadata JSONB, -- Flexible JSON storage for additional wallet details
    purchase_id TEXT UNIQUE, -- Optional: Links to a CustomerPurchase if finalized. UNIQUE as one wallet per purchase.
    offramp_evm_address VARCHAR(42), -- Address where funds are moved after verification
    
    -- Foreign key constraint to customer_purchases (can be NULL if not yet linked)
    CONSTRAINT fk_purchase
        FOREIGN KEY (purchase_id)
        REFERENCES customer_purchases(id)
        ON DELETE SET NULL -- If a purchase is deleted, this wallet might become unlinked

    -- Foreign key constraint to offer
    CONSTRAINT fk_offer
        FOREIGN KEY (offer_id)
        REFERENCES offers(id)
        ON DELETE SET NULL -- If an offer is deleted, this wallet might become unlinked
    
);

COMMENT ON TABLE deposit_wallets IS 'Stores details of cryptocurrency deposit wallets for customer checkouts.';
COMMENT ON COLUMN deposit_wallets.evm_address IS 'The EVM address of the deposit wallet.';
COMMENT ON COLUMN deposit_wallets.private_key IS 'The private key for the deposit wallet. **CRITICAL: Encrypt this field in production.**';
COMMENT ON COLUMN deposit_wallets.seed_phrase IS 'The seed phrase for the deposit wallet. **CRITICAL: Encrypt this field in production.**';
COMMENT ON COLUMN deposit_wallets.latest_usd_balance IS 'The latest observed balance of the wallet in USD.';
COMMENT ON COLUMN deposit_wallets.purchase_id IS 'Links to the customer purchase record once checkout is finalized.';


-- Table for Customer Purchases
-- Represents a customer's active purchase of a vendor offer.
-- This table holds the current state and billing parameters for a purchase.
CREATE TABLE customer_purchases (
    id TEXT PRIMARY KEY, -- Unique identifier for this vendor's purchase record (e.g., 'CustomerPurchase_...')
    wallet_id TEXT NOT NULL UNIQUE, -- Foreign key to the deposit_wallets table. UNIQUE as one wallet per purchase.
    customer_purchase_id TEXT NOT NULL UNIQUE, -- ID from OfficeX for this purchase (JobRunID)
    title VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL, -- e.g., 'active', 'suspended', 'terminated'
    description TEXT,
    customer_user_id TEXT NOT NULL, -- OfficeX UserID of the customer
    customer_org_id TEXT NOT NULL, -- OfficeX DriveID (organization ID)
    customer_org_endpoint TEXT NOT NULL, -- Endpoint for OfficeX organization API
    customer_org_api_key TEXT NOT NULL, -- API key for OfficeX organization. **CRITICAL: Encrypt this field in production.**
    vendor_id TEXT NOT NULL, -- Our internal vendor ID
    pricing JSONB NOT NULL, -- Flexible JSON for pricing model details (e.g., per-GB, per-API-call)
    customer_check_billing_api_key TEXT NOT NULL UNIQUE, -- API key for customer to check billing. **CRITICAL: Encrypt this field in production.**
    vendor_update_billing_api_key TEXT NOT NULL UNIQUE, -- API key for authorized servers to update billing. **CRITICAL: Encrypt this field in production.**
    vendor_notes TEXT,
    balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000, -- Current balance for this purchase in USD
    balance_low_trigger NUMERIC(18, 6) NOT NULL, -- Threshold to notify customer of low balance
    balance_critical_trigger NUMERIC(18, 6) NOT NULL, -- Threshold to notify customer of critical balance
    balance_termination_trigger NUMERIC(18, 6) NOT NULL, -- Threshold to terminate service
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    tracer TEXT,
    metadata JSONB,

    -- Foreign key constraint to deposit_wallets
    CONSTRAINT fk_wallet
        FOREIGN KEY (wallet_id)
        REFERENCES deposit_wallets(id)
        ON DELETE RESTRICT -- A purchase cannot exist without its associated wallet
);

COMMENT ON TABLE customer_purchases IS 'Records of customer purchases, including current balance and billing parameters.';
COMMENT ON COLUMN customer_purchases.wallet_id IS 'Foreign key to the deposit wallet associated with this purchase.';
COMMENT ON COLUMN customer_purchases.customer_purchase_id IS 'The unique purchase ID provided by OfficeX.';
COMMENT ON COLUMN customer_purchases.customer_org_api_key IS 'API key for interacting with the customer''s OfficeX organization. **CRITICAL: Encrypt this field in production.**';
COMMENT ON COLUMN customer_purchases.pricing IS 'JSON object detailing the pricing model for this specific purchase.';
COMMENT ON COLUMN customer_purchases.customer_check_billing_api_key IS 'API key for the customer to query their billing status. **CRITICAL: Encrypt this field in production.**';
COMMENT ON COLUMN customer_purchases.vendor_update_billing_api_key IS 'API key for authorized services to report usage and update balance. **CRITICAL: Encrypt this field in production.**';
COMMENT ON COLUMN customer_purchases.balance IS 'The current remaining balance for this purchase.';
COMMENT ON COLUMN customer_purchases.balance_low_trigger IS 'Balance threshold for sending a "low balance" notification.';
COMMENT ON COLUMN customer_purchases.balance_critical_trigger IS 'Balance threshold for sending a "critical balance" notification.';
COMMENT ON COLUMN customer_purchases.balance_termination_trigger IS 'Balance threshold at which services for this purchase are terminated.';


-- Table for Usage Records (TimescaleDB Hypertable)
-- This table will store individual usage events for each customer purchase.
-- It's designed as a TimescaleDB hypertable for efficient time-series queries.
CREATE TABLE usage_records (
    id BIGSERIAL PRIMARY KEY, -- Auto-incrementing ID for each usage record
    purchase_id TEXT NOT NULL, -- Foreign key to the customer_purchases table
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- The time of the usage event (TimescaleDB time column)
    usage_amount NUMERIC(18, 6) NOT NULL, -- The quantity of usage (e.g., GB, API calls)
    unit VARCHAR(50) NOT NULL, -- The unit of usage (e.g., 'GB', 'API_CALLS', 'MS')
    cost_incurred NUMERIC(18, 6) NOT NULL, -- The cost deducted for this specific usage event
    description TEXT, -- Description of the usage event (e.g., 'S3 storage usage', 'Gemini API call')
    metadata JSONB, -- Flexible JSON for additional usage details (e.g., S3 bucket name, Gemini model used)

    -- Foreign key constraint to customer_purchases
    CONSTRAINT fk_purchase_usage
        FOREIGN KEY (purchase_id)
        REFERENCES customer_purchases(id)
        ON DELETE CASCADE -- If a purchase is deleted, its usage records should also be deleted
);

COMMENT ON TABLE usage_records IS 'Time-series records of usage events for customer purchases.';
COMMENT ON COLUMN usage_records.purchase_id IS 'Foreign key to the customer purchase this usage belongs to.';
COMMENT ON COLUMN usage_records.timestamp IS 'The timestamp of the usage event. This is the time-series dimension for TimescaleDB.';
COMMENT ON COLUMN usage_records.usage_amount IS 'The quantity of usage incurred in this event.';
COMMENT ON COLUMN usage_records.unit IS 'The unit of the usage amount (e.g., GB, API_CALLS).';
COMMENT ON COLUMN usage_records.cost_incurred IS 'The cost deducted from the balance for this specific usage event.';
COMMENT ON COLUMN usage_records.metadata IS 'Additional JSON metadata for the usage event.';

-- Convert usage_records table to a TimescaleDB hypertable
-- This enables time-series features like continuous aggregates, downsampling, etc.
SELECT create_hypertable('usage_records', 'timestamp', if_not_exists => TRUE);

-- Optional: Create indexes for frequently queried columns
CREATE INDEX idx_offers_sku ON offers (sku);
CREATE INDEX idx_deposit_wallets_evm_address ON deposit_wallets (evm_address);
CREATE INDEX idx_customer_purchases_customer_purchase_id ON customer_purchases (customer_purchase_id);
CREATE INDEX idx_customer_purchases_customer_user_id ON customer_purchases (customer_user_id);
CREATE INDEX idx_customer_purchases_customer_org_id ON customer_purchases (customer_org_id);
CREATE INDEX idx_customer_purchases_customer_check_billing_api_key ON customer_purchases (customer_check_billing_api_key);
CREATE INDEX idx_customer_purchases_vendor_update_billing_api_key ON customer_purchases (vendor_update_billing_api_key);
-- For usage_records, TimescaleDB automatically creates an index on the time column.
-- An additional index on purchase_id is highly recommended for filtering usage by purchase.
CREATE INDEX idx_usage_records_purchase_id_timestamp ON usage_records (purchase_id, timestamp DESC);
