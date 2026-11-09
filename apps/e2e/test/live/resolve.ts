/**
 * Loads the live Programar mensagem conversation from Postgres.
 *
 * Calls `shouldRunLiveTests` so a remote `DATABASE_URL` fails closed and writes
 * nothing. Opt-in is checked first so a forgotten flag never opens Prisma.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  PrismaClient,
  RemoteDatabaseTestTargetError,
  resolveDatabaseTarget,
  shouldRunLiveTests,
} from "@select-lub/core/db";
import { evaluateLiveScheduleGate, type LiveDbTarget, type LiveScheduleGateResult } from "./gate.js";
import { ensureLiveConversation } from "./ensure-conversation.js";

const envPath = resolve(import.meta.dirname, "../../../../.env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function dbTargetFromEnv(env: NodeJS.ProcessEnv): LiveDbTarget {
  const target = resolveDatabaseTarget(env);
  switch (target.kind) {
    case "absent":
      return { kind: "absent" };
    case "local":
      return { kind: "local" };
    case "remote":
      return {
        kind: "remote",
        host: target.host,
        allowRemote: env.LIVE_TESTS_ALLOW_REMOTE === "1",
      };
    case "unparseable":
      return { kind: "unparseable" };
  }
}

/**
 * Resolves whether the live suite may run against this process environment.
 *
 * @param env - Defaults to `process.env`
 * @returns Skip, fail, or the conversation to drive
 */
export async function resolveLiveScheduleContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveScheduleGateResult> {
  const optIn = env.E2E_LIVE_SCHEDULE;
  const db = dbTargetFromEnv(env);
  if (optIn !== "1") {
    return evaluateLiveScheduleGate({ optIn, db, conversation: null });
  }
  if (db.kind === "remote" && !db.allowRemote) {
    const classified = evaluateLiveScheduleGate({ optIn, db, conversation: null });
    return classified;
  }
  try {
    const equipped = shouldRunLiveTests(env);
    if (!equipped) {
      return evaluateLiveScheduleGate({ optIn, db: { kind: "absent" }, conversation: null });
    }
  } catch (error) {
    if (error instanceof RemoteDatabaseTestTargetError) {
      return { kind: "fail", message: error.message };
    }
    throw error;
  }

  const prisma = new PrismaClient();
  try {
    const ensured = await ensureLiveConversation(
      prisma,
      env.EVOLUTION_INSTANCE_NAME?.trim() || "Select Lub",
    );
    if (ensured.kind === "fail") {
      return ensured;
    }
    return evaluateLiveScheduleGate({
      optIn,
      db: { kind: "local" },
      conversation: ensured.conversation,
    });
  } finally {
    await prisma.$disconnect();
  }
}
