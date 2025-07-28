# Vendor Server

Template for an OfficeX vendor server responsible for selling Amazon S3 Storage Buckets, and Gemini API Keys.
In general, every vendor can have its own unique billing flow, so just use this template as a guideline not a hard rule.

## Quickstart

Initial Setup

```sh
# install dependencies
npm install
cp .env.example .env
```

Run Server

```sh
# build and run
$ docker compose up --build -d

# view logs
$ docker compose logs -f

# clear and restart, wipe volumes
$ docker compose down --volumes

# or restart fresh
$ docker compose down --volumes && docker compose up --build -d && docker compose logs -f
```

## Routes

Overview of routes exposed by this vendor server:

- 🔓 `GET /appstore/suggest`
- 🔓 `GET /appstore/list/:list_id`

- 🔓 `GET /offer/:offer_id`
- 🔓 `POST /offer/:offer_id/checkout/wallet/create`
- 🔓 `POST /offer/:offer_id/checkout/wallet/:wallet_id/verify`
- 🔓 `POST /offer/:offer_id/checkout/finalize`

- 🔐 `GET /purchase/:purchase_id`
- 🔐 `POST /purchase/:purchase_id/meter-usage`
- 🔐 `POST /purchase/:purchase_id/verify-topup`
- 🔐 `POST /purchase/:purchase_id/historical-billing`

## Flow

### Appstore List

1. Customers on OfficeX appstore ping `GET /appstore/suggest` to get a list of suggested offers based on their info like keyboard, ip country, profession, known preferences, etc. This returns a list of urls to `GET /appstore/list/:list_id`
2. Customers on OfficeX can view a list of offers on the appstore `GET /appstore/list/:list_id`

### Purchase Checkout

1. Customer views vendor offer on OfficeX Appstore `GET /offer/:offer_id`
2. Customer requests a deposit wallet with min target balance, which this vendor server creates and stores in postgres `POST /offer/:offer_id/checkout/wallet/create`
3. Customer sends payment to deposit wallet, typically USDC or USDT
4. Customer verifies validity of payment, which this server checks if the deposit wallet has the expected balance `POST /offer/:offer_id/checkout/wallet/:wallet_id/verify`
5. Customer completes checkout and this vendor server creates a customer purchase record in postgres, with balance amount. This might be using an init script in phala cloud `POST /offer/:offer_id/checkout/finalize`
6. Vendor typically has to send a bit of gas to the deposit wallet so that it can move the funds to offramp wallet
7. Vendor fulfills the customer purchase and updates the customers OfficeX org purchase record
8. Every offer has its own billing method, and we typically just notify the customer when funds are low
9. Customer can view their purchase record `GET /purchase/:purchase_id` with auth `CustomerPurchase.customer_check_billing_api_key` which should match their own OfficeX records

### Usage Based Billing

In general, different product offers have different billing patterns. We expose a simple endpoint to handle accounting in an agnostic way.

1. Vendor server exposes a route `POST /purchase/:purchase_id/meter-usage` that any authorized server with auth token == `CustomerPurchase.vendor_update_billing_api_key` can call to notify us of the usage. The endpoint will update the customer purchase record in postgres billing (timescaledb), deducting balance for that purchase record.
2. If balance gets too low, customer is notified and asked to top up
3. Customer can call a "verify_topup_wallet" endpoint to verify if the deposit wallet has exceeded the min target balance. If yes, then the funds are moved to the offramp wallet and we update both customer purchase record in vendor postgres, as well as customer OfficeX purchase record. `POST /purchase/:purchase_id/verify-topup` with auth `CustomerPurchase.customer_check_billing_api_key`
4. There are 3 balance triggers: `balance_low_trigger`, `balance_critical_trigger`, and `balance_termination_trigger`. These are used to notify the customer when their balance is low or critical. The final termination balance will actually delete resources.
5. At any time, the customer can call `POST /purchase/:purchase_id/historical-billing` to get a historical billing report for that purchase record.

### Amazon S3 Billing

1. Every day, an organization-wide AWS S3 buckets cost report is exported as CSV, detailing daily consumption per bucket
2. Daily script will parse the CSV to calculate the usage.
3. Script calls the `POST /purchase/:purchase_id/meter-usage` endpoint with auth `CustomerPurchase.vendor_update_billing_api_key` to update customer balances.

### Gemini API Key Billing

This example implements a more real-time billing flow that is still agnostic to where the actual AI server is located. We simply expose an endpoint that the AI server can call to notify us of the usage.

1. Expose a POST request endpoint `POST /purchase/:purchase_id/meter-usage` with auth `CustomerPurchase.vendor_update_billing_api_key` that the AI server can call to notify us of the usage. The endpoint will update the customer purchase record in postgres billing (timescaledb), deducting balance.
2. If balance gets too low, customer is notified and asked to top up
3. Customer can call a "verify_topup_wallet" endpoint to verify if the deposit wallet has exceeded the min target balance. If yes, then the funds are moved to the offramp wallet and we update both customer purchase record in vendor postgres, as well as customer OfficeX purchase record. `POST /purchase/:purchase_id/verify-topup` with auth `CustomerPurchase.customer_check_billing_api_key`

## Dangers

While batch daily job is a simple and effective way to handle billing, there is danger in "cross-chain latency" where Google/Amazon sends billing details 8 hours after the actual usage is incurred. The customer may not have enough funds to cover the costs.

This can be solved by more realtime billing so that the customer is notified as soon as the usage is incurred, and resources are disabled if the customer runs out of funds.
