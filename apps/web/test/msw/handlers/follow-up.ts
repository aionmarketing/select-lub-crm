import { http, HttpResponse } from "msw";
import type { FollowUpResult } from "@select-lub/shared-types";

const emptyFollowUp: FollowUpResult = {
  counts: {
    unansweredQuotes: 0,
    overdueReturns: 0,
    upcomingReturns: 0,
    waitingReply: 0,
  },
  unansweredQuotes: [],
  overdueReturns: [],
  upcomingReturns: [],
  waitingReply: [],
};

export const followUpHandlers = [http.get("*/api/follow-ups", () => HttpResponse.json(emptyFollowUp))];
