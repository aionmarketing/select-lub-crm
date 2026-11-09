/**
 * Persists a quote with its frozen lines. The prices on the lines are the ones
 * offered at the time; a later catalog change never reaches a stored quote.
 */
import type { DbClient } from "@select-lub/core/db";
import type { OilQuote } from "../../contracts/http.js";
import { iso } from "./column-readers.js";
import type { OilQuoteStore } from "./store.js";

/**
 * @param prisma - The client the quote runs on.
 * @returns The quote-writing part of {@link OilQuoteStore}.
 */
export function quoteWrites(prisma: DbClient): Pick<OilQuoteStore, "createQuote"> {
  return {
    async createQuote(input) {
      const saved = await prisma.oilQuote.create({
        data: {
          customerId: input.customerId,
          vehicleId: input.vehicleId,
          conversationId: input.conversationId,
          generatedMessageText: input.generatedMessageText,
          createdByUserId: input.createdByUserId,
          lines: {
            create: input.lines.map((line) => ({
              catalogItemId: line.catalogItemId,
              brand: line.brand,
              description: line.description,
              price: line.price,
            })),
          },
        },
        include: { lines: true },
      });
      const quote: OilQuote = {
        id: saved.id,
        customerId: saved.customerId,
        vehicleId: saved.vehicleId,
        conversationId: saved.conversationId,
        generatedMessageText: saved.generatedMessageText,
        createdBy: saved.createdByUserId,
        lines: saved.lines.map((line) => ({
          catalogItemId: line.catalogItemId,
          brand: line.brand,
          description: line.description,
          price: line.price.toNumber(),
        })),
        createdAt: iso(saved.createdAt),
        updatedAt: iso(saved.updatedAt),
      };
      return quote;
    },
  };
}
