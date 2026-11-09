/**
 * Clientes perdidos no período and Receita média por cliente: the customer
 * figures on the Relatórios screen, for one period.
 *
 * Moved from `apps/api/src/reports/insights.ts`, unchanged, when that file split
 * by topic under the line cap.
 */
import { suggestDate, type IntervalRuleInput } from "../../services/contracts/http.js";
import type { AttributionServiceRow } from "./attribution.js";
import { inHalfOpenPeriod } from "./calendar.js";
import { amountOf, isOmieOrigin } from "./service-revenue.js";

/**
 * Clientes perdidos no período and Receita média por cliente for one period, per the
 * relatorios requirement "Lapsed customers and average revenue follow the period".
 *
 * A customer lapses in the period when the return date derived from their latest
 * unit service (interval rules, else BR-06's six months — the rule Follow-up uses)
 * falls inside `[periodStart, periodEnd)`; being the latest service is what "no
 * newer service followed" means. `churnRate` divides that count by every unit
 * customer with at least one dated service. `ltv` is the Omie-origin service
 * `amount` performed inside the period, divided by the customers who had a
 * service in it.
 *
 * The three counts travel with the two rates because the screen prints them
 * ("7" and "18% dos 39 clientes com serviço"; "entre os 32 clientes com
 * serviço"): `lapsedCustomers` is the numerator of `churnRate`,
 * `customersWithService` its base, and `customersServedInPeriod` the divisor
 * of `ltv`.
 *
 * @param services - Unit services; rows outside the unit or without `performedAt` are ignored.
 * @param rules - Interval rules shared with Follow-up retorno vencido.
 * @param periodStart - Inclusive start instant of the period.
 * @param periodEnd - Exclusive end instant of the period.
 * @returns All five null when no customer had a service inside the period.
 */
export function churnAndLtv(
  services: AttributionServiceRow[],
  unitId: string,
  rules: IntervalRuleInput[],
  periodStart: Date,
  periodEnd: Date,
): {
  churnRate: number | null;
  ltv: number | null;
  lapsedCustomers: number | null;
  customersWithService: number | null;
  customersServedInPeriod: number | null;
} {
  const byCustomer = new Map<string, AttributionServiceRow[]>();
  for (const service of services) {
    if (service.unitId !== unitId || !service.performedAt) {
      continue;
    }
    const list = byCustomer.get(service.customerId) ?? [];
    list.push(service);
    byCustomer.set(service.customerId, list);
  }
  const inPeriod = new Map<string, AttributionServiceRow[]>();
  for (const [customerId, rows] of byCustomer) {
    const periodRows = rows.filter((row) => inHalfOpenPeriod(row.performedAt as Date, periodStart, periodEnd));
    if (periodRows.length > 0) {
      inPeriod.set(customerId, periodRows);
    }
  }
  if (inPeriod.size === 0) {
    return {
      churnRate: null,
      ltv: null,
      lapsedCustomers: null,
      customersWithService: null,
      customersServedInPeriod: null,
    };
  }
  let lapsed = 0;
  for (const rows of byCustomer.values()) {
    const latest = rows.reduce((best, row) =>
      (row.performedAt?.getTime() ?? 0) > (best.performedAt?.getTime() ?? 0) ? row : best,
    );
    const suggestion = suggestDate({
      performedAt: latest.performedAt as Date,
      kind: null,
      rules,
    });
    if (inHalfOpenPeriod(suggestion.suggestedAt, periodStart, periodEnd)) {
      lapsed += 1;
    }
  }
  let revenue = 0;
  for (const rows of inPeriod.values()) {
    revenue += rows.filter(isOmieOrigin).reduce((sum, row) => sum + amountOf(row), 0);
  }
  return {
    churnRate: lapsed / byCustomer.size,
    ltv: revenue / inPeriod.size,
    lapsedCustomers: lapsed,
    customersWithService: byCustomer.size,
    customersServedInPeriod: inPeriod.size,
  };
}
