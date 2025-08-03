// src/server.ts
import dotenv from "dotenv";
dotenv.config();

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginAsync } from "fastify";
import * as fs from "fs";
import * as path from "path";
import fp from "fastify-plugin";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyCron from "fastify-cron";

import { DatabaseService } from "./services/database";
import {
  OfferID,
  CheckoutWalletID,
  CustomerPurchaseID,
  Offer,
  CheckoutWallet,
  CustomerPurchase,
} from "./types/core.types";
import { JobRunStatus } from "@officexapp/types";
import { appstore_suggest_handler } from "./handlers/appstore/suggest";
import { appstore_list_handler } from "./handlers/appstore/list";
import { get_offer_handler } from "./handlers/checkout/get-offer";
import { checkout_init_handler } from "./handlers/checkout/checkout-init";
import { verify_deposit_wallet_handler } from "./handlers/checkout/checkout-validate";
import { finalize_checkout_handler } from "./handlers/checkout/checkout-finalize";
// import { get_purchase_handler } from "./handlers/purchase/get-purchase";
import { meter_usage_handler } from "./handlers/purchase/meter-usage";
// import { verify_topup_handler } from "./handlers/purchase/verify-topup";
import { historical_billing_handler } from "./handlers/purchase/historical-billing";
import { authenticateCustomerBillingCheck, authenticateVendorUpdateBilling } from "./services/auth";
import { MeterService } from "./services/meter";
import { checkout_topup_handler } from "./handlers/checkout/checkout-topup";
import { AwsService } from "./services/aws-s3";
import { get_purchase_handler } from "./handlers/purchase/get-purchase";
import { validate_auth_handler } from "./handlers/purchase/validate-auth";

// Extend FastifyInstance to include our decorated 'db' property
declare module "fastify" {
  interface FastifyInstance {
    db: DatabaseService;
    meter: MeterService;
    aws: AwsService;
  }
}

// Health Check Route
const HEALTH_ROUTE = "/health";
// Appstore Routes
const APPSTORE_SUGGEST_ROUTE = "/v1/appstore/suggest";
const APPSTORE_LIST_ROUTE = "/v1/appstore/list/:list_id";
// Offer Routes
const OFFER_VIEW_ROUTE = "/v1/offer/:offer_id";
// Checkout Routes
const CHECKOUT_INIT_ROUTE = "/v1/checkout/initiate";
const CHECKOUT_VERIFY_ROUTE = "/v1/checkout/validate";
const CHECKOUT_FINALIZE_ROUTE = "/v1/checkout/finalize";
const CHECKOUT_TOPUP_ROUTE = "/v1/checkout/topup";
// Purchase Routes
const PURCHASE_VIEW_ROUTE = "/v1/purchase/:purchase_id";
const PURCHASE_METER_USAGE_ROUTE = "/v1/purchase/:purchase_id/meter-usage";
const PURCHASE_HISTORICAL_BILLING_ROUTE = "/v1/purchase/:purchase_id/historical-billing";
const PURCHASE_VALIDATE_AUTH_ROUTE = "/v1/purchase/:purchase_id/validate-auth";

// Customer Dashboard Route
const CUSTOMER_DASHBOARD_ROUTE = "/v1/dashboard/customer";

// --- Start the server ---
const start = async () => {
  const fastify: FastifyInstance = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss Z",
          ignore: "pid,hostname",
        },
      },
    },
  });

  const servicesPlugin: FastifyPluginAsync = async (fastify) => {
    await fastify.register(fastifyCors, {
      origin: "*", // Allow all origins
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], // Allowed methods
      allowedHeaders: ["Content-Type", "Authorization"], // Allowed headers
    });

    // Initialize DatabaseService (assuming it's not already done elsewhere)
    const databaseService = new DatabaseService(process.env.DATABASE_URL!);
    await databaseService.connect();
    fastify.decorate("db", databaseService);

    // Initialize MeterService and decorate Fastify instance
    const meterService = new MeterService(databaseService);
    fastify.decorate("meter", meterService);

    // Initialize AwsService and decorate Fastify instance
    const AWS_REGION = process.env.AWS_REGION || "us-east-1"; // Get region from env var
    const awsService = new AwsService(AWS_REGION);
    fastify.decorate("aws", awsService); // Decorate as 'awsService'

    // Ensure database disconnects on server close
    fastify.addHook("onClose", async (instance) => {
      await instance.db.disconnect();
    });
  };

  await fastify.register(
    fp(servicesPlugin, {
      name: "services",
      dependencies: [],
    }),
  );

  // --- Fastify Hooks for Database Lifecycle ---
  fastify.addHook("onReady", async () => {
    try {
      await fastify.db.connect();
      fastify.log.info("Database connected and ready.");
    } catch (error) {
      fastify.log.error("Failed to connect to database on startup:", error);
      process.exit(1);
    }
  });

  fastify.addHook("onClose", async () => {
    await fastify.db.disconnect();
    fastify.log.info("Database pool disconnected.");
  });

  await fastify.register(fastifyCron, {
    jobs: [
      {
        cronTime: "0 3 * * *", // Run every day at 3:00 AM UTC for previous day data. this ensures we have the complete data for the previous day
        onTick: async (server) => {
          server.log.info("Cron job started: Running daily billing job.");
          try {
            const today = new Date();
            const yesterdayTimestamp = today.getTime() - 24 * 60 * 60 * 1000;
            const yesterday = new Date(yesterdayTimestamp);
            await server.aws.runDailyBillingJob(server.db, yesterday);
            server.log.info("Cron job finished: Daily billing job complete. ✅");
          } catch (error) {
            server.log.error("Cron job failed: Error during daily billing job.", error);
          }
        },
        start: true, // Start the job automatically
        name: "daily-billing-job",
      },
    ],
  });

  fastify.get(HEALTH_ROUTE, async (request, reply) => {
    const today = new Date();
    const yesterdayTimestamp = today.getTime() - 24 * 60 * 60 * 1000;
    const yesterday = new Date(yesterdayTimestamp);
    await request.server.aws.runDailyBillingJob(request.server.db, yesterday);
    request.server.log.info("Cron job finished: Daily billing job complete. ✅");
    reply.send({ status: `ok - healthy 👌` });
  });
  fastify.get(APPSTORE_SUGGEST_ROUTE, appstore_suggest_handler);
  fastify.get(APPSTORE_LIST_ROUTE, appstore_list_handler);

  fastify.get(OFFER_VIEW_ROUTE, get_offer_handler);
  fastify.post(CHECKOUT_INIT_ROUTE, checkout_init_handler);
  fastify.post(CHECKOUT_VERIFY_ROUTE, verify_deposit_wallet_handler);
  fastify.post(CHECKOUT_FINALIZE_ROUTE, finalize_checkout_handler);
  fastify.post(CHECKOUT_TOPUP_ROUTE, checkout_topup_handler);
  fastify.get(PURCHASE_VIEW_ROUTE, { preHandler: [authenticateCustomerBillingCheck] }, get_purchase_handler);
  fastify.post(PURCHASE_METER_USAGE_ROUTE, { preHandler: [authenticateVendorUpdateBilling] }, meter_usage_handler);
  fastify.post(
    PURCHASE_HISTORICAL_BILLING_ROUTE,
    { preHandler: [authenticateCustomerBillingCheck] },
    historical_billing_handler,
  );
  fastify.post(PURCHASE_VALIDATE_AUTH_ROUTE, validate_auth_handler);

  const customerDashboardPath = path.join(__dirname, "dashboard", "customer");

  fastify.get(CUSTOMER_DASHBOARD_ROUTE, (req, reply) => {
    reply.sendFile("index.html", path.join(customerDashboardPath, "dist"));
  });

  // Catch-all for React app for client-side routing
  // This route will now handle both GET and implicit HEAD requests for the SPA root
  fastify.get(`${CUSTOMER_DASHBOARD_ROUTE}/*`, (req, reply) => {
    reply.sendFile("index.html", path.join(customerDashboardPath, "dist"));
  });

  // Always serve the static built files, regardless of NODE_ENV
  fastify.log.info(`Serving customer dashboard from: ${path.join(customerDashboardPath, "dist")}`);
  fastify.register(fastifyStatic, {
    root: path.join(customerDashboardPath, "dist"),
    prefix: CUSTOMER_DASHBOARD_ROUTE,
    decorateReply: true,
    schemaHide: true,
    wildcard: false,
    setHeaders: (res, path, stat) => {
      // For HTML file, ensure no-cache to avoid issues with new builds
      if (path.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  });

  fastify.log.info("Registered Routes:");
  fastify.printRoutes({ commonPrefix: false });

  try {
    const port = parseInt(process.env.PORT || "3001", 10);
    const host = "0.0.0.0"; // Listen on all network interfaces

    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on ${host}:${port}`);
    fastify.log.info(`Node environment: ${process.env.NODE_ENV}`);
    fastify.log.info(`Sanity Check Env: ${process.env.SANITY_CHECK_ENV}`);

    // --- Load and initialize default offers from JSON ---
    const defaultOffersFilePath = path.join(__dirname, "config", "default_offers.json");
    let defaultOffers: Offer[] = [];

    try {
      const rawData = fs.readFileSync(defaultOffersFilePath, "utf8");
      defaultOffers = JSON.parse(rawData);
      fastify.log.info(`Loaded ${defaultOffers.length} default offers from ${defaultOffersFilePath}`);
    } catch (readError) {
      fastify.log.error(`Failed to read default offers JSON file at ${defaultOffersFilePath}:`, readError);
      fastify.log.warn("Proceeding without loading default offers from JSON.");
    }

    if (defaultOffers.length > 0) {
      fastify.log.info("Checking for and adding default offers to database...");
      for (const offerData of defaultOffers) {
        try {
          const existingOffer = await fastify.db.getOfferById(offerData.id);
          if (!existingOffer) {
            // Add current timestamps as they are not in the JSON
            const offerToCreate: Offer = {
              ...offerData,
              created_at: Date.now(),
              updated_at: Date.now(),
            };
            await fastify.db.createOffer(offerToCreate);
            fastify.log.info(`Added new default offer: ${offerToCreate.title} (${offerToCreate.id})`);
          } else {
            fastify.log.debug(`Default offer already exists: ${existingOffer.title} (${existingOffer.id})`);
          }
        } catch (dbError) {
          fastify.log.error(`Error processing default offer ${offerData.id}:`, dbError);
        }
      }
      fastify.log.info("Default offers initialization complete.");
    } else {
      fastify.log.info("No default offers to initialize (either JSON was empty or could not be read).");
    }
    // --- End default offers initialization ---
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
