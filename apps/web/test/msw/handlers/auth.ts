import { http, HttpResponse } from "msw";

export const authHandlers = [
  http.get("*/api/auth/me", () =>
    HttpResponse.json({
      id: "11111111-1111-1111-1111-111111111111",
      email: "attendant@example.com",
      name: "Atendente",
      unitIds: ["unit-test"],
      currentUnitId: "unit-test",
    }),
  ),
];
