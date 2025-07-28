// src/server.ts

import Fastify, {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  FastifyPluginAsync,
} from "fastify";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import fp from "fastify-plugin";

import { DatabaseService } from "./services/database";
import {
  OfferID,
  DepositWalletID,
  CustomerPurchaseID,
  Offer,
  DepositWallet,
  CustomerPurchase,
  OfferSKU,
} from "./types/core.types";
import { JobRunStatus } from "@officexapp/types";
import { appstore_suggest_handler } from "./handlers/appstore/suggest";
import { appstore_list_handler } from "./handlers/appstore/list";
import { get_offer_handler } from "./handlers/offer/get-offer";
import { create_deposit_wallet_handler } from "./handlers/offer/create-deposit-wallet";
import { verify_deposit_wallet_handler } from "./handlers/offer/verify-deposit-wallet";
import { finalize_checkout_handler } from "./handlers/offer/finalize-checkout";
import { get_purchase_handler } from "./handlers/purchase/get-purchase";
import { meter_usage_handler } from "./handlers/purchase/meter-usage";
import { verify_topup_handler } from "./handlers/purchase/verify-topup";
import { historical_billing_handler } from "./handlers/purchase/historical-billing";
import {
  authenticateCustomerBillingCheck,
  authenticateVendorUpdateBilling,
} from "./services/auth";
import { MeterService } from "./services/meter";

// Load environment variables from .env file
dotenv.config();

// Extend FastifyInstance to include our decorated 'db' property
declare module "fastify" {
  interface FastifyInstance {
    db: DatabaseService;
    meter: MeterService;
  }
}

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
  // Initialize DatabaseService (assuming it's not already done elsewhere)
  const databaseService = new DatabaseService(process.env.DATABASE_URL!);
  await databaseService.connect();
  fastify.decorate("db", databaseService);

  // Initialize MeterService and decorate Fastify instance
  const meterService = new MeterService(databaseService);
  fastify.decorate("meterService", meterService); // <--- NEW DECORATION

  // Ensure database disconnects on server close
  fastify.addHook("onClose", async (instance) => {
    await instance.db.disconnect();
  });
};

export default fp(servicesPlugin, {
  name: "services",
  dependencies: [], // Add dependencies if this plugin relies on others
});
fastify.register(servicesPlugin);

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

fastify.get("/health", (request, reply) => {
  reply.send({ status: "ok - healthy" });
});
fastify.get("/appstore/suggest", appstore_suggest_handler);
fastify.get("/appstore/list/:list_id", appstore_list_handler);
fastify.get("/offer/:offer_id", get_offer_handler);
fastify.post(
  "/offer/:offer_id/checkout/wallet/create",
  create_deposit_wallet_handler
);
fastify.post(
  "/offer/:offer_id/checkout/wallet/:wallet_id/verify",
  verify_deposit_wallet_handler
);
fastify.post("/offer/:offer_id/checkout/finalize", finalize_checkout_handler);
fastify.get(
  "/purchase/:purchase_id",
  { preHandler: [authenticateCustomerBillingCheck] },
  get_purchase_handler
);
fastify.post(
  "/purchase/:purchase_id/meter-usage",
  { preHandler: [authenticateVendorUpdateBilling] },
  meter_usage_handler
);
fastify.post(
  "/purchase/:purchase_id/verify-topup",
  { preHandler: [authenticateCustomerBillingCheck] },
  verify_topup_handler
);
fastify.post(
  "/purchase/:purchase_id/historical-billing",
  { preHandler: [authenticateCustomerBillingCheck] },
  historical_billing_handler
);

// --- Start the server ---
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || "3001", 10);
    const host = "0.0.0.0"; // Listen on all network interfaces

    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on ${host}:${port}`);
    fastify.log.info(`Node environment: ${process.env.NODE_ENV}`);
    fastify.log.info(`Sanity Check Env: ${process.env.SANITY_CHECK_ENV}`);

    // --- Load and initialize default offers from JSON ---
    const defaultOffersFilePath = path.join(
      __dirname,
      "config",
      "default_offers.json"
    );
    let defaultOffers: Offer[] = [];

    try {
      const rawData = fs.readFileSync(defaultOffersFilePath, "utf8");
      defaultOffers = JSON.parse(rawData);
      fastify.log.info(
        `Loaded ${defaultOffers.length} default offers from ${defaultOffersFilePath}`
      );
    } catch (readError) {
      fastify.log.error(
        `Failed to read default offers JSON file at ${defaultOffersFilePath}:`,
        readError
      );
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
            fastify.log.info(
              `Added new default offer: ${offerToCreate.title} (${offerToCreate.id})`
            );
          } else {
            fastify.log.debug(
              `Default offer already exists: ${existingOffer.title} (${existingOffer.id})`
            );
          }
        } catch (dbError) {
          fastify.log.error(
            `Error processing default offer ${offerData.id}:`,
            dbError
          );
        }
      }
      fastify.log.info("Default offers initialization complete.");
    } else {
      fastify.log.info(
        "No default offers to initialize (either JSON was empty or could not be read)."
      );
    }
    // --- End default offers initialization ---
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
