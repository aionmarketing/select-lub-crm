import { http, HttpResponse } from "msw";

export const conversasHandlers = [
  http.get("*/api/conversations/:id/vehicles", () =>
    HttpResponse.json({ customerId: null, vehicles: [] }),
  ),
  http.get("*/api/conversations/:id/customer", () =>
    HttpResponse.json({ customer: null, pendings: [] }),
  ),
  http.get("*/api/conversations/:id/services", () =>
    HttpResponse.json({ customerId: null, services: [] }),
  ),
  http.get("*/api/conversations/:id/messages", () => HttpResponse.json([])),
  http.get("*/api/conversations", () => HttpResponse.json([])),
  http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
  http.get("*/api/reconciliation-pendings", () => HttpResponse.json([])),
  http.get("*/api/conversations/:id/scheduled-messages", () => HttpResponse.json([])),
  http.post("*/api/plate-lookups", () => HttpResponse.json({ status: "unavailable" })),
];
