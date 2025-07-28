import { FastifyReply, FastifyRequest } from "fastify";
import { OfferID } from "../../types/core.types";

// GET /offer/:offer_id
export const get_offer_handler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const { offer_id } = request.params as { offer_id: OfferID };
  request.log.info(`GET /offer/${offer_id} called`);

  try {
    const offer = await request.server.db.getOfferById(offer_id);
    if (!offer) {
      reply.status(404).send({ error: "Offer not found" });
      return;
    }
    // Return public offer details
    return {
      id: offer.id,
      sku: offer.sku,
      title: offer.title,
      description: offer.description,
      metadata: offer.metadata, // Include metadata if it's public
    };
  } catch (error) {
    request.log.error(`Error getting offer ${offer_id}:`, error);
    reply.status(500).send({ error: "Internal server error" });
  }
};
