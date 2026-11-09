import { http, HttpResponse } from "msw";

export const tagsHandlers = [
  http.get("*/api/tags/apply-options", () => HttpResponse.json([])),
  http.get("*/api/tags", () => HttpResponse.json([])),
  http.get("*/api/templates", () => HttpResponse.json([])),
];
