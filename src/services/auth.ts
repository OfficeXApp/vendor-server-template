// src/services/auth.ts

// src/auth.ts

import { FastifyRequest, FastifyReply } from "fastify";
import { CustomerPurchaseID } from "../types/core.types"; // Adjust path as needed
import { DatabaseService } from "../services/database"; // Adjust path as needed

/**
 * Extracts the authentication token from either the Authorization header (Bearer)
 * or the 'auth' query parameter.
 * @param request The FastifyRequest object.
 * @returns The extracted token string, or null if not found/invalid.
 */
function extractToken(request: FastifyRequest): string | null {
  // 1. Check Authorization header
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7); // "Bearer ".length is 7
  }

  // 2. Check 'auth' query parameter
  const authQuery = (request.query as { auth?: string }).auth;
  if (authQuery) {
    return authQuery;
  }

  return null; // No token found
}

/**
 * Pre-handler for routes requiring CustomerPurchase.vendor_update_billing_api_key.
 * (e.g., POST /purchase/:purchase_id/notify-usage)
 */
export async function authenticateVendorUpdateBilling(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { purchase_id } = request.params as { purchase_id: CustomerPurchaseID };
  const token = extractToken(request);

  if (!token) {
    request.log.warn(
      `Unauthorized access attempt to ${request.url}: No token provided.`
    );
    reply
      .status(401)
      .send({ error: "Unauthorized: Authentication token required." });
    return;
  }

  try {
    const purchase =
      await request.server.db.getCustomerPurchaseById(purchase_id);

    if (!purchase) {
      request.log.warn(
        `Unauthorized access attempt to ${request.url}: Purchase ID ${purchase_id} not found.`
      );
      reply
        .status(401)
        .send({ error: "Unauthorized: Invalid purchase ID or token." });
      return;
    }

    if (token !== purchase.vendor_update_billing_api_key) {
      request.log.warn(
        `Unauthorized access attempt to ${request.url}: Invalid vendor update billing API key for purchase ${purchase_id}.`
      );
      reply.status(401).send({
        error: "Unauthorized: Invalid vendor update billing API key.",
      });
      return;
    }

    // If authentication is successful, continue to the route handler
    request.log.debug(
      `Vendor update billing authenticated for purchase ${purchase_id}.`
    );
  } catch (error) {
    request.log.error(
      `Authentication error for ${request.url} (purchase ${purchase_id}):`,
      error
    );
    reply
      .status(500)
      .send({ error: "Internal server error during authentication." });
  }
}

/**
 * Pre-handler for routes requiring CustomerPurchase.customer_check_billing_api_key.
 * (e.g., GET /purchase/:purchase_id, POST /purchase/:purchase_id/verify-topup, POST /purchase/:purchase_id/historical-billing)
 */
export async function authenticateCustomerBillingCheck(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { purchase_id } = request.params as { purchase_id: CustomerPurchaseID };
  const token = extractToken(request);

  if (!token) {
    request.log.warn(
      `Unauthorized access attempt to ${request.url}: No token provided.`
    );
    reply
      .status(401)
      .send({ error: "Unauthorized: Authentication token required." });
    return;
  }

  try {
    const purchase =
      await request.server.db.getCustomerPurchaseById(purchase_id);

    if (!purchase) {
      request.log.warn(
        `Unauthorized access attempt to ${request.url}: Purchase ID ${purchase_id} not found.`
      );
      reply
        .status(401)
        .send({ error: "Unauthorized: Invalid purchase ID or token." });
      return;
    }

    if (token !== purchase.customer_check_billing_api_key) {
      request.log.warn(
        `Unauthorized access attempt to ${request.url}: Invalid customer check billing API key for purchase ${purchase_id}.`
      );
      reply.status(401).send({
        error: "Unauthorized: Invalid customer check billing API key.",
      });
      return;
    }

    // If authentication is successful, continue to the route handler
    request.log.debug(
      `Customer billing check authenticated for purchase ${purchase_id}.`
    );
  } catch (error) {
    request.log.error(
      `Authentication error for ${request.url} (purchase ${purchase_id}):`,
      error
    );
    reply
      .status(500)
      .send({ error: "Internal server error during authentication." });
  }
}
