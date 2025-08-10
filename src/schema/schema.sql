-- Enable the TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Set the time zone for the session to UTC for consistency
SET TIME ZONE 'UTC';

-- Table to track applied migrations
CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table for Offers
-- Represents the products or services available for purchase (e.g., Amazon S3, Gemini API Key)
CREATE TABLE IF NOT EXISTS offers (
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
-- Initially created without the fk_purchase constraint due to circular dependency.
CREATE TABLE IF NOT EXISTS checkout_wallets (
    id TEXT PRIMARY KEY, -- Unique identifier for the deposit wallet (e.g., 'CheckoutWallet_...')
    checkout_flow_id TEXT,
    checkout_session_id TEXT,
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
    offer_id TEXT, -- ADDED: Column to link to the offers table
    email TEXT,
    
    -- Foreign key constraint to offer (can be added now as offers table exists)
    CONSTRAINT fk_offer
        FOREIGN KEY (offer_id)
        REFERENCES offers(id)
        ON DELETE SET NULL -- If an offer is deleted, this wallet might become unlinked
);

COMMENT ON TABLE checkout_wallets IS 'Stores details of cryptocurrency deposit wallets for customer checkouts.';
COMMENT ON COLUMN checkout_wallets.evm_address IS 'The EVM address of the deposit wallet.';
COMMENT ON COLUMN checkout_wallets.private_key IS 'The private key for the deposit wallet. **CRITICAL: Encrypt this field in production.**';
COMMENT ON COLUMN checkout_wallets.seed_phrase IS 'The seed phrase for the deposit wallet. **CRITICAL: Encrypt this field in production.**';
COMMENT ON COLUMN checkout_wallets.latest_usd_balance IS 'The latest observed balance of the wallet in USD.';
COMMENT ON COLUMN checkout_wallets.purchase_id IS 'Links to the customer purchase record once checkout is finalized.';


-- Table for Customer Purchases
-- Represents a customer's active purchase of a vendor offer.
-- This table holds the current state and billing parameters for a purchase.
-- Initially created without the fk_wallet constraint due to circular dependency.
CREATE TABLE IF NOT EXISTS customer_purchases (
    id TEXT PRIMARY KEY, -- Unique identifier for this vendor's purchase record (e.g., 'CustomerPurchase_...')
    wallet_id TEXT UNIQUE, -- Foreign key to the checkout_wallets table. UNIQUE as one wallet per purchase.
    officex_purchase_id TEXT NOT NULL UNIQUE, -- ID from OfficeX for this purchase (PurchaseID)
    checkout_session_id TEXT NOT NULL UNIQUE, -- 
    title VARCHAR(255) NOT NULL,
    description TEXT,
    customer_user_id TEXT NOT NULL, -- OfficeX UserID of the customer
    customer_org_id TEXT NOT NULL, -- OfficeX DriveID (organization ID)
    customer_org_host TEXT NOT NULL, -- Endpoint for OfficeX organization API
    vendor_id TEXT NOT NULL, -- Our internal vendor ID
    price_line TEXT NOT NULL, -- Flexible JSON for pricing model details (e.g., per-GB, per-API-call)
    customer_billing_api_key TEXT NOT NULL UNIQUE, -- API key for customer to check billing. **CRITICAL: Encrypt this field in production.**
    vendor_billing_api_key TEXT NOT NULL UNIQUE, -- API key for authorized servers to update billing. **CRITICAL: Encrypt this field in production.**
    vendor_notes TEXT,
    balance_low_trigger NUMERIC(18, 6) NOT NULL, -- Threshold to notify customer of low balance
    balance_critical_trigger NUMERIC(18, 6) NOT NULL, -- Threshold to notify customer of critical balance
    balance_termination_trigger NUMERIC(18, 6) NOT NULL, -- Threshold to terminate service
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    tracer TEXT,
    metadata JSONB
);

COMMENT ON TABLE customer_purchases IS 'Records of customer purchases, including current balance and billing parameters.';
COMMENT ON COLUMN customer_purchases.wallet_id IS 'Foreign key to the deposit wallet associated with this purchase.';
COMMENT ON COLUMN customer_purchases.officex_purchase_id IS 'The unique purchase ID provided by OfficeX.';
COMMENT ON COLUMN customer_purchases.customer_org_host IS 'Endpoint for OfficeX organization API.'; -- CORRECTED COMMENT
COMMENT ON COLUMN customer_purchases.price_line IS 'JSON object detailing the pricing model for this specific purchase.';
COMMENT ON COLUMN customer_purchases.customer_billing_api_key IS 'API key for the customer to query their billing status. **CRITICAL: Encrypt this field in production.**';
COMMENT ON COLUMN customer_purchases.vendor_billing_api_key IS 'API key for authorized services to report usage and update balance. **CRITICAL: Encrypt this field in production.**';
COMMENT ON COLUMN customer_purchases.balance_low_trigger IS 'Balance threshold for sending a "low balance" notification.';
COMMENT ON COLUMN customer_purchases.balance_critical_trigger IS 'Balance threshold for sending a "critical balance" notification.';
COMMENT ON COLUMN customer_purchases.balance_termination_trigger IS 'Balance threshold at which services for this purchase are terminated.';



-- Table for Usage Records (TimescaleDB Hypertable)
-- This table will store individual usage events for each customer purchase.
-- It's designed as a TimescaleDB hypertable for efficient time-series queries.
CREATE TABLE IF NOT EXISTS usage_records (
    id BIGSERIAL, -- Auto-incrementing ID for each usage record
    purchase_id TEXT NOT NULL, -- Foreign key to the customer_purchases table
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- The time of the usage event (TimescaleDB time column)
    usage_amount NUMERIC(18, 6) NOT NULL, -- The quantity of usage (e.g., GB, API calls)
    usage_unit TEXT NOT NULL, -- The unit of usage (e.g., 'GB', 'API_CALLS', 'MS') -- CHANGED FROM VARCHAR(50) TO TEXT
    billed_amount NUMERIC(18, 6) NOT NULL, -- The cost deducted for this specific usage event
    description TEXT, -- Description of the usage event (e.g., 'S3 storage usage', 'Gemini API call')
    metadata JSONB, -- Flexible JSON for additional usage details (e.g., S3 bucket name, Gemini model used)

    -- Primary key must include the time column for TimescaleDB hypertables if a unique index exists
    PRIMARY KEY (id, timestamp), -- MODIFIED: Composite primary key including 'timestamp'

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
COMMENT ON COLUMN usage_records.usage_unit IS 'The unit of the usage amount (e.g., GB, API_CALLS).';
COMMENT ON COLUMN usage_records.billed_amount IS 'The cost deducted from the balance for this specific usage event.';
COMMENT ON COLUMN usage_records.metadata IS 'Additional JSON metadata for the usage event.';

-- Convert usage_records table to a TimescaleDB hypertable
-- This enables time-series features like continuous aggregates, downsampling, etc.
SELECT create_hypertable('usage_records', 'timestamp', if_not_exists => TRUE);

-- Optional: Create indexes for frequently queried columns
CREATE INDEX IF NOT EXISTS idx_offers_sku ON offers (sku);
CREATE INDEX IF NOT EXISTS idx_checkout_wallets_evm_address ON checkout_wallets (evm_address);
CREATE INDEX IF NOT EXISTS idx_checkout_wallets_checkout_session_id ON checkout_wallets (checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_customer_purchases_customer_purchase_id ON customer_purchases (officex_purchase_id);
CREATE INDEX IF NOT EXISTS idx_customer_purchases_customer_user_id ON customer_purchases (customer_user_id);
CREATE INDEX IF NOT EXISTS idx_customer_purchases_customer_org_id ON customer_purchases (customer_org_id);
CREATE INDEX IF NOT EXISTS idx_customer_purchases_customer_check_billing_api_key ON customer_purchases (customer_billing_api_key);
CREATE INDEX IF NOT EXISTS idx_customer_purchases_vendor_update_billing_api_key ON customer_purchases (vendor_billing_api_key);
-- For usage_records, TimescaleDB automatically creates an index on the time column.
-- An additional index on purchase_id is highly recommended for filtering usage by purchase.
CREATE INDEX IF NOT EXISTS idx_usage_records_purchase_id_timestamp ON usage_records (purchase_id, timestamp DESC);
