import { http, HttpResponse } from "msw";

export const prefillHandlers = [
  http.get("*/api/conversations/:id/prefill", () =>
    HttpResponse.json({ status: "empty", extractEnabled: false }),
  ),
];
