/**
 * Zod contracts for service orders (OS) synced from Omie.
 *
 * Moved from `packages/shared-types/src/service.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

const nullableString = z.string().nullable();

const nullableNumber = z.number().nullable();

/** Line item on a service order, including optional oil-change product metadata. */
export const serviceItemSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  description: z.string().trim().min(1),
  kind: nullableString,
  quantity: nullableNumber,
  unitAmount: nullableNumber,
  lineAmount: nullableNumber,
  oilViscosity: nullableString,
  oilBrand: nullableString,
});

/** Response body for a service order with its line items. */
export const serviceSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  vehicleId: nullableString,
  omieId: nullableString,
  unitId: z.string(),
  performedAt: nullableString,
  description: nullableString,
  kind: nullableString,
  status: nullableString,
  amount: nullableNumber,
  odometerKm: nullableNumber,
  origin: z.string().trim().min(1),
  items: z.array(serviceItemSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Response body for service orders resolved from a conversation's linked customer. */
export const conversationServicesSchema = z.object({
  customerId: z.string().nullable(),
  services: z.array(serviceSchema),
});

/** Response body for a flat list of service orders. */
export const serviceListSchema = z.array(serviceSchema);

/** One row on the unit-wide Serviços screen (customer + vehicle labels, absent fields stay null). */
export const unitServiceRowSchema = serviceSchema.extend({
  customerName: z.string(),
  vehiclePlate: nullableString,
  vehicleMake: nullableString,
  vehicleModel: nullableString,
  vehicleYear: z.number().int().nullable(),
});

/** Calendar date `YYYY-MM-DD`, the form the Serviços period control produces. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Query string for `GET /services`. Every field is optional: omitting `from`
 * and `to` means no date bound, omitting `search` means no text filter, and
 * omitting `cursor` means the first page — never the whole unit.
 */
export const unitServiceQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    search: z.string().trim().min(1).optional(),
    /**
     * Return state of the vehicle the service was performed on, read from that
     * vehicle's stored return rather than recomputed — the same row Follow-up
     * reads, so the two screens cannot place the same car differently.
     */
    returnState: z.enum(["vencido", "aproximando"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
  })
  .superRefine((query, ctx) => {
    // YYYY-MM-DD compares lexicographically the same way it compares in time.
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      ctx.addIssue({ code: "custom", message: "from must not be after to", path: ["from"] });
    }
  });

/**
 * Response body for `GET /services` — one bounded page of the current unit's
 * services. `nextCursor` carries the means to request the next page and is
 * non-null exactly when `hasMore` is true. `totalCount` and `totalAmount`
 * describe every row matching the query, not just this page, so the screen can
 * say whether you are looking at all of them; services with a null `amount`
 * contribute nothing to the total.
 */
export const unitServicePageSchema = z
  .object({
    rows: z.array(unitServiceRowSchema),
    hasMore: z.boolean(),
    nextCursor: nullableString,
    totalCount: z.number().int().nonnegative(),
    totalAmount: z.number(),
  })
  .superRefine((page, ctx) => {
    if (page.hasMore !== (page.nextCursor !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "nextCursor must be present exactly when hasMore is true",
        path: ["nextCursor"],
      });
    }
  });

/** The oil quote attributed to a service by the Relatórios attribution rule. */
export const serviceQuoteAttributionSchema = z.object({
  quoteId: z.string(),
  sentAt: z.string(),
  ruleVersion: z.number().int(),
});

/**
 * Response body for `GET /services/:id` — one service in full. `odometerKm` on
 * the row is the reading recorded at the moment of the service, never a current
 * or derived value.
 */
export const serviceDetailSchema = unitServiceRowSchema.extend({
  attributedQuote: serviceQuoteAttributionSchema.nullable(),
  vehicleHistory: z.array(serviceSchema),
});

/** Line item on a service order, including optional oil-change product metadata. */
export type ServiceItem = z.infer<typeof serviceItemSchema>;

/** Service order with its line items. */
export type Service = z.infer<typeof serviceSchema>;

/** Service orders resolved from a conversation's linked customer. */
export type ConversationServices = z.infer<typeof conversationServicesSchema>;

/** Unit-wide Serviços row with customer and vehicle labels. */
export type UnitServiceRow = z.infer<typeof unitServiceRowSchema>;

/** Parsed `GET /services` query: date bound, search term, return state, and paging. */
export type UnitServiceQuery = z.infer<typeof unitServiceQuerySchema>;

/** One page of unit-wide Serviços rows plus its continuation. */
export type UnitServicePage = z.infer<typeof unitServicePageSchema>;

/** Quote attributed to a service, with the rule version that attributed it. */
export type ServiceQuoteAttribution = z.infer<typeof serviceQuoteAttributionSchema>;

/** One service in full: its row, its attributed quote, and its vehicle's other services. */
export type ServiceDetail = z.infer<typeof serviceDetailSchema>;
