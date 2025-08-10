# Vendor Server

Template for an OfficeX vendor server responsible for selling Amazon S3 Storage Buckets, and Gemini API Keys.
In general, every vendor can have its own unique billing flow, so just use this template as a guideline not a hard ruleset (just abide by the REST API spec)

## Quickstart

Initial Setup

### Environment Variables

```sh
# install dependencies
npm install
cp .env.example .env
```

Explanation of mandatory env vars:

- `YOUR_VENDOR_ID` simply an OfficeX profile which you can generate by creating a new anonymous profile on [officex.app](https://officex.app). That ID looks like `Anon@UserID_jkeg5-2qa7q-62dqi-bucbf-yvnv5-7gs6l-gdb3t-aejtj-3vr3p-m2md6-xae` (which is just an ICP public key address prefixed with "UserID")
-
-
-

### Docker Build & Run

Build and run the vendor server with docker compose

```sh
# build and run
$ docker compose up --build -d

# view logs
$ docker compose logs -f

# clear and restart, wipe volumes
$ docker compose down --volumes

# or restart fresh
$ docker compose down --volumes && docker compose up --build -d && docker compose logs -f

# enter docker container
$ docker exec -it vendor-server-app-1 bash
```

dashboard frontend for hot reloading in development (in production its handled by docker)

```sh
cd src/dashboard/customer
npm install
npm run dev
```

### Production Docker

```sh
# build & run in background
docker-compose -f docker-compose.prod.yml up --build -d
# view logs
docker-compose -f docker-compose.prod.yml logs --tail 500 -f

# safe restart
docker-compose -f docker-compose.prod.yml restart
```

### Sentry Error Tracking

You may optionally setup Sentry Error Tracking by filling out .env variable `SENTRY_DSN`. Create one at [sentry.io](https://sentry.io).

To upload sourcemaps to Sentry, run the `upload-sentry-sourcemaps.sh` script but replace with your project-id.

```sh
# Make it executable
chmod +x upload-sentry-sourcemaps.sh

# Build the project
npm run build

# Run it manually when you want to upload source maps
./upload-sentry-sourcemaps.sh
```

### Cost Reports via Storage Lens

AWS S3 buckets are tagged with `officex_vendor_purchase_id` tag, which is used for billing purposes. You must set up a daily cost export on AWS Cost Explorer to export the cost report to a CSV file in a target S3 bucket.

1. First [setup a daily data export on AWS Cost Explorer](https://us-east-1.console.aws.amazon.com/costmanagement/home?region=us-east-1#/bcm-data-exports) to export the cost report to a CSV file, with the following settings:
   - Title `officex-vendor-billing-report`
   - Data table `CUR 2.0`
   - Granularity `daily`
   - Compression `gzip - text/csv`
   - File versioning `Create new data export file`
   - S3 bucket, create new titled `officex-vendor-billing-reports-{YOUR_VENDOR_ID}` and path prefix `officex-vendor-billing-reports`
   - Tags, `{officex_vendor_purchase_id: "officex_vendor_billing_reports"}`
     This daily export job will create a new daily file in the S3 bucket.

2. Go to your newly created S3 bucket `officex-vendor-billing-reports-{YOUR_VENDOR_ID}` and add tag `{officex_vendor_purchase_id: "officex_vendor_billing_reports"}`

3. Enable the tag `officex_vendor_purchase_id` to be used in billing on [aws cost allocation tags page](https://us-east-1.console.aws.amazon.com/costmanagement/home?region=us-east-1#/tags). Depending on your AWS account, the tag might take a few hours to a day to appear.

Your automated billing should now work. A daily cron job will run on this.

## Routes

Overview of routes exposed by this vendor server:

- 🔓 `GET /appstore/suggest`
- 🔓 `GET /appstore/list/:list_id`

- 🔓 `GET /offer/:offer_id`

- 🔓 `POST /checkout/initiate`
- 🔓 `POST /checkout/validate`
- 🔓 `POST /checkout/finalize`
- 🔓 `POST /checkout/topup`

- 🔐 `GET /purchase/:purchase_id`
- 🔐 `POST /purchase/:purchase_id/meter-usage`
- 🔐 `POST /purchase/:purchase_id/historical-billing`

## Flow

### Appstore List

1. Customers on OfficeX appstore ping `GET /appstore/suggest` to get a list of suggested offers based on their info like keyboard, ip country, profession, known preferences, etc. This returns a list of urls to `GET /appstore/list/:list_id`
2. Customers on OfficeX can view a list of offers on the appstore `GET /appstore/list/:list_id`

### Purchase Checkout

1. Customer views vendor offer on OfficeX Appstore `GET /offer/:offer_id`
2. Customer requests a deposit wallet with min target balance, which this vendor server creates and stores in postgres `POST /offer/:offer_id/checkout/initiate`
3. Customer sends payment to deposit wallet, typically USDC or USDT
4. Customer verifies validity of payment, which this server checks if the deposit wallet has the expected balance `POST /offer/:offer_id/checkout/validate`
5. Customer completes checkout and this vendor server creates a customer purchase record in postgres, with balance amount. This might be using an init script in phala cloud `POST /offer/:offer_id/checkout/finalize`
6. Vendor typically has to send a bit of gas to the deposit wallet so that it can move the funds to offramp wallet
7. Vendor fulfills the customer purchase and updates the customers OfficeX org purchase record
8. Every offer has its own billing method, and we typically just notify the customer when funds are low
9. Customer can view their purchase record `GET /purchase/:purchase_id` with auth `CustomerPurchase.customer_billing_api_key` which should match their own OfficeX records

### Usage Based Billing

In general, different product offers have different billing patterns. We expose a simple endpoint to handle accounting in an agnostic way.

1. Vendor server exposes a route `POST /purchase/:purchase_id/meter-usage` that any authorized server with auth token == `CustomerPurchase.vendor_billing_api_key` can call to notify us of the usage. The endpoint will update the customer purchase record in postgres billing (timescaledb), deducting balance for that purchase record.
2. If balance gets too low, customer is notified and asked to top up
3. Customer can call a "verify_topup_wallet" endpoint to verify if the deposit wallet has exceeded the min target balance. If yes, then the funds are moved to the offramp wallet and we update both customer purchase record in vendor postgres, as well as customer OfficeX purchase record. `POST /purchase/:purchase_id/verify-topup` with auth `CustomerPurchase.customer_billing_api_key`
4. There are 3 balance triggers: `balance_low_trigger`, `balance_critical_trigger`, and `balance_termination_trigger`. These are used to notify the customer when their balance is low or critical. The final termination balance will actually delete resources.
5. At any time, the customer can call `POST /purchase/:purchase_id/historical-billing` to get a historical billing report for that purchase record.

### Amazon S3 Billing

1. Every day, an organization-wide AWS S3 buckets cost report is exported as CSV, detailing daily consumption per bucket
2. Daily script will parse the CSV to calculate the usage.
3. Script calls the `POST /purchase/:purchase_id/meter-usage` endpoint with auth `CustomerPurchase.vendor_billing_api_key` to update customer balances.

### Gemini API Key Billing

This example implements a more real-time billing flow that is still agnostic to where the actual AI server is located. We simply expose an endpoint that the AI server can call to notify us of the usage.

1. Expose a POST request endpoint `POST /purchase/:purchase_id/meter-usage` with auth `CustomerPurchase.vendor_billing_api_key` that the AI server can call to notify us of the usage. The endpoint will update the customer purchase record in postgres billing (timescaledb), deducting balance.
2. If balance gets too low, customer is notified and asked to top up
3. Customer can call a "verify_topup_wallet" endpoint to verify if the deposit wallet has exceeded the min target balance. If yes, then the funds are moved to the offramp wallet and we update both customer purchase record in vendor postgres, as well as customer OfficeX purchase record. `POST /purchase/:purchase_id/verify-topup` with auth `CustomerPurchase.customer_billing_api_key`

## Dangers

### Billing Latency

While batch daily job is a simple and effective way to handle billing, there is danger in "cross-chain latency" where Google/Amazon sends billing details 8 hours after the actual usage is incurred. The customer may not have enough funds to cover the costs.

This can be solved by more realtime billing so that the customer is notified as soon as the usage is incurred, and resources are disabled if the customer runs out of funds.

### Empty S3 Bucket

The code handles emptying S3 buckets but not deleting the bucket itself. Because emptying is a long running process and I didnt want to deal with the extra complexity of edge cases. So for now, you must delete the buckets manually. AWS accounts can have up to 10k buckets.

### Gas Tank

You must add gas to the vendor wallet so that it can move funds from checkout wallets to offramp wallets. Remember each checkout wallet is a new wallet, so you must add gas to each one, and it costs ~$0.40 per wallet. If your vendor wallet runs out of gas, the vending machine will not work and customer funds are stuck while not receiving product. You will need to manually remedy them. Avoid this by adding gas to the vendor wallet to prevent this.
