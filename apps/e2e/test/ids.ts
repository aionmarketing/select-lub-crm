/**
 * Stable ids and phones for Playwright fixtures (`seed-e2e.ts`).
 * Chat keys are 11-digit BR mobiles so inbox labels are unique vs the demo seed.
 */
export const E2E = {
  namelessPhone: "11999000001",
  cadastroPhone: "11999000002",
  sendPhone: "11999000003",
  schedulePhone: "11999000004",
  sendName: "E2E Envio",
  scheduleName: "E2E Agenda",
  namelessCustomerId: "e2e-cust-nameless",
  cadastroCustomerId: "e2e-cust-cadastro",
  sendCustomerId: "e2e-cust-send",
  scheduleCustomerId: "e2e-cust-schedule",
  namelessConversationId: "e2e-conv-nameless",
  cadastroConversationId: "e2e-conv-cadastro",
  sendConversationId: "e2e-conv-send",
  scheduleConversationId: "e2e-conv-schedule",
  freeServiceId: "e2e-svc-free",
  occupiedServiceId: "e2e-svc-occupied",
  occupiedScheduleId: "e2e-sched-occupied",
  sendText: "Oleo 5W30 combinado",
  cadastroName: "Maria E2E",

  // Retroactive tour fixtures (change `exploratory-tour-tests`, task 5.2). The
  // four rows above cover inbox, cadastro, send and schedule; the tours of
  // vehicles, returns, reminders, catalogs and the oil quote need shapes none
  // of them have. They hang off one extra customer so a tour can reach all of
  // them from a single conversation, and so the demo dataset stays untouched.
  tourPhone: "11999000005",

  // Assistive-prefill ghosts get their OWN customers, not the tour customer.
  // Accepting a ghost WRITES the suggested fields onto that conversation's
  // customer, so a ghost parked on `tourCustomerId` would rewrite the cadastro
  // tour's customer underneath it the first time the accept tour ran. Same
  // reasoning as the Omie-conflict fixture: a fixture must not reach a customer
  // another spec asserts on.
  //
  // Two of them, because `CadastroPrefillSuggestion.conversationId` is unique —
  // one conversation cannot carry both an accepted and a dismissed ghost.
  // The suggested value itself lives here so the seed and the tour read ONE
  // source. A tour must not assert a value because the drive displayed it.
  prefillSuggestedName: "Marina Duarte",
  prefillAcceptCustomerId: "e2e-cust-prefill-accept",
  prefillAcceptPhone: "11999000006",
  prefillAcceptConversationId: "e2e-conv-prefill-accept",
  prefillAcceptJobId: "e2e-prefill-job-accept",
  prefillAcceptSuggestionId: "e2e-prefill-sug-accept",

  prefillDismissCustomerId: "e2e-cust-prefill-dismiss",
  prefillDismissPhone: "11999000007",
  prefillDismissConversationId: "e2e-conv-prefill-dismiss",
  prefillDismissJobId: "e2e-prefill-job-dismiss",
  prefillDismissSuggestionId: "e2e-prefill-sug-dismiss",

  // Omie reconciliation conflict. A NEW customer, per design decision 6:
  // `conversas-cadastro.spec.ts` asserts `getByText("Omie")` has count 0 on the
  // whole page, so a linkage on the customer that spec drives would turn it red.
  //
  // And the NAME must not contain "Omie" either, which decision 6 does not say.
  // That assertion is page-wide and the inbox list is on the page, so a customer
  // called "E2E Omie" would match it from its own conversation row. Measured
  // 2026-09-16 by reading the spec before seeding, not by turning it red.
  omieConflictCustomerId: "e2e-cust-conciliacao",
  omieConflictCustomerName: "E2E Conciliação",
  omieConflictOmieId: "omie-e2e-conciliacao",
  omieConflictPhone: "11999000008",
  omieConflictConversationId: "e2e-conv-conciliacao",

  // Two fields on ONE customer, because the panel's count is of FIELDS rather
  // than customers — `prefill.tsx` says so in its own comment. One conflict
  // could not tell the two readings apart.
  //
  // Values sit far apart on purpose: a near-identical pair would pass an
  // assertion that had picked up the wrong side.
  omieConflictCityCrm: "Niterói",
  omieConflictCityOmie: "Petrópolis",
  omieConflictPostalCrm: "24020000",
  omieConflictPostalOmie: "25680000",

  // Disconnected WhatsApp channel, driven only by
  // `playwright.tours-disconnected.config.ts`, which points that API process's
  // `EVOLUTION_INSTANCE_NAME` at this instance.
  //
  // A SEPARATE instance rather than a flipped state on the shared one: every
  // other tour needs CONNECTED, and a tour that mutates shared state leaves the
  // database wrong whenever it fails partway — which tours do, by design, while
  // being written.
  //
  // It is also why this is a separate CONFIG and not just a separate row.
  // `channelStatus()` resolves the connection by the configured instance name,
  // so a second connection is invisible to the screen unless a process is
  // pointed at it.
  disconnectedInstanceName: "e2e-canal-desconectado",
  disconnectedConnectionId: "e2e-conn-desconectado",
  disconnectedCustomerId: "e2e-cust-desconectado",
  disconnectedCustomerName: "E2E Canal Fora",
  disconnectedPhone: "11999000009",
  disconnectedConversationId: "e2e-conv-desconectado",
  // A service on that customer, so the schedule control EXISTS to be blocked.
  // Without it the rail shows an empty `Mensagens programadas` and there is no
  // control at all — which would make a "scheduling is blocked" assertion
  // vacuous: it would pass on a customer who simply has nothing to schedule.
  disconnectedServiceId: "e2e-svc-desconectado",

  // Oil-quote REUSE fixture (change close-stated-coverage-gaps, section 6).
  //
  // The identity is not a free choice. Since background-oil-research PR 4 the
  // quote calls no provider: it shows the latest `MotulCompatibility` row and
  // prices the filters from the matching `TecfilCompatibility` row, and with no
  // Tecfil row the filters read as not yet consulted. Measured 2026-09-16: the
  // seeded data carries Motul rows for Polo 2018-2023 but exactly ONE Tecfil
  // row, 2021. So 2021 is the only year where both halves are stored.
  //
  // Plate-less: the plate cache no longer feeds the quote (research runs on the
  // four identity fields, D6), and none of the fixture's real plates resolves
  // to a car with a citable oil source anyway.
  quoteVehicleId: "e2e-veh-quote-polo",
  quoteVehicleMake: "Volkswagen",
  quoteVehicleModel: "Polo",
  quoteVehicleVersion: "1.0 TSI",
  quoteVehicleYear: 2021,
  quoteMotulCompatibilityId: "e2e-motul-polo-2021",
  quoteTecfilCompatibilityId: "e2e-tecfil-polo-2021",
  /**
   * A COMPLETE identity with no cache row (background-oil-research task 5.5): opening its quote
   * queues a research, and with no worker on the tour stack that research reads `researching` with
   * `paused: stopped`. Plate-less, so nothing looks a plate up; no fixture or seed stores a Motul
   * or Tecfil row for it.
   */
  researchVehicleId: "e2e-veh-research-kwid",
  researchVehicleMake: "Renault",
  researchVehicleModel: "Kwid",
  researchVehicleVersion: "1.0 SCe Intense",
  researchVehicleYear: 2023,
  tourName: "E2E Turista",
  tourCustomerId: "e2e-cust-tour",
  tourConversationId: "e2e-conv-tour",
  /** First of the customer's two vehicles; carries the overdue return. */
  /** Plate the cadastro tour looks up; the canned dataset answers HONDA / FIT. */
  tourKnownPlate: "DEF2E34",
  /** Plate the canned dataset answers as a miss. */
  tourUnknownPlate: "TES7T01",
  tourVehicleAId: "e2e-veh-a",
  tourVehicleAPlate: "ABC1D23",
  /** Second vehicle, deliberately with no return, so grouping is observable. */
  tourVehicleBId: "e2e-veh-b",
  tourVehicleBPlate: "XYZ9K88",
  /** Service on vehicle A that the overdue return is dated from. */
  tourReturnServiceId: "e2e-svc-return",
  tourReturnId: "e2e-return-open",
  tourReminderId: "e2e-reminder-open",
  tourTagId: "e2e-tag-tour",
  tourTagName: "E2E Turista Tag",
  tourTemplateId: "e2e-template-tour",
  tourTemplateName: "E2E Retorno",
  /** Quote header only — lines need a Motul/Tecfil catalog the tour must not reach. */
  tourOilQuoteId: "e2e-quote-tour",
} as const;
