/**
 * The api's composition root: bind the database, the auth hook, `/health`,
 * each module's `httpPlugin`, then the SPA. Every piece is core's; what is
 * decided here is which port each module is handed. This process never sends
 * WhatsApp: the enqueue routes write outbox rows.
 */
import { resolve } from "node:path";
import { clients, kernel } from "@select-lub/core";
import { runInTransactionFor, type DbClient, type RunInTransaction } from "@select-lub/core/db";
import * as accounts from "@select-lub/core/modules/accounts";
import * as channel from "@select-lub/core/modules/channel";
import * as conversations from "@select-lub/core/modules/conversations";
import * as customers from "@select-lub/core/modules/customers";
import * as plateLookup from "@select-lub/core/modules/plate-lookup";
import * as prefill from "@select-lub/core/modules/prefill";
import * as quotes from "@select-lub/core/modules/quotes";
import * as reports from "@select-lub/core/modules/reports";
import * as scheduling from "@select-lub/core/modules/scheduling";
import * as services from "@select-lub/core/modules/services";
import { MEDIA_MAX_BYTES } from "@select-lub/shared-types";

/**
 * The database the app runs on, and the external ports a test may stub. An
 * omitted port is the production adapter; there is no in-memory arm.
 */
export type BuildAppOptions = {
  db: DbClient;
  runInTransaction?: RunInTransaction;
  omieAdapter?: clients.omie.OmieAdapter;
  getUser?: kernel.GetUser;
  createAuthUser?: accounts.CreateAuthUser;
  /** `null` skips the SPA; a path serves that build. */
  spaRoot?: string | null;
  plateProvider?: clients.PlateProvider | null;
  /** Defaults to `EVOLUTION_INSTANCE_NAME`, resolved once so an unset one refuses at startup. */
  evolutionInstanceName?: string;
  /** The LIVE Evolution probe; a test pins it so no suite reaches the real instance. */
  channelConnected?: scheduling.ChannelConnected;
  fetchMedia?: conversations.FetchMediaPort;
};

/** Builds the configured, not-yet-listening app. */
export async function buildApp(options: BuildAppOptions) {
  const app = await kernel.buildApp({
    mediaMaxBytes: MEDIA_MAX_BYTES,
    corsOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
  });
  const db = options.db;
  // Module slices read `request.server.db`. Bound before any plugin registers.
  kernel.bindDb(app, kernel.createDb(db, options.runInTransaction ?? runInTransactionFor(db)));
  const channelConnected = options.channelConnected ?? (() => channel.fetchEvolutionConnected());
  const instanceName = channel.resolveEvolutionInstanceName(options.evolutionInstanceName);
  const cadastroStore = customers.createCadastroStore(app.db);
  const omieAdapter = options.omieAdapter ?? clients.omie.createOmieAdapter();
  const getUser = options.getUser ?? kernel.createSupabaseGetUser();
  kernel.registerAuthHook(app, { getUser, authStore: accounts.createCallerDirectory(app.db) });
  kernel.registerApiHealth(app, db);

  const createAuthUser = options.createAuthUser ?? accounts.createSupabaseCreateAuthUser();
  await accounts.createHttpPlugin({ createAuthUser })(app);
  // Nova conversa reads the STORED connection state; the sends and the media
  // download ask the LIVE probe (the two-source rule).
  await conversations.createHttpPlugin({
    instanceName: () => instanceName,
    channelConnected,
    fetchMedia: options.fetchMedia ?? channel.fetchEvolutionMedia,
    templateValues: customers.templateValuesFrom(cadastroStore),
  })(app);
  await channel.createHttpPlugin({ instanceName: () => instanceName })(app);
  await reports.createHttpPlugin({ unansweredQuotes: conversations.unansweredQuoteCount })(app);
  await scheduling.createHttpPlugin({ channelConnected })(app);
  // The customers slices push to Omie synchronously through this app's adapter,
  // held in the plugin's closure, never a process-wide port (W2-C6).
  await customers.createHttpPlugin({ omieAdapter })(app);
  const plateProvider =
    options.plateProvider === undefined ? clients.placasProviders.createPlacasProvider() : options.plateProvider;
  await plateLookup.createHttpPlugin({ plateProvider })(app);
  // Undefined in production, where quotes builds its ports per request.
  await quotes.createHttpPlugin({ omieAdapter })(app);
  await services.createHttpPlugin()(app);
  await prefill.createHttpPlugin({ omieAdapter })(app);

  const spaDir = kernel.resolveSpaRoot(options.spaRoot, resolve(import.meta.dirname, "../../web/dist"));
  if (spaDir) {
    await kernel.registerSpa(app, spaDir);
  }
  return app;
}
