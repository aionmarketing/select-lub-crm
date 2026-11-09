import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { planWhatsAppConnectionSeed } from "../src/kernel/prisma/plan-whatsapp-connection-seed.js";
import { seedCatalogItems } from "../src/kernel/prisma/catalog-seed.js";
import { resolveSeedPermission } from "../src/kernel/prisma/seed-permission.js";
import { isDemoSeedEnabled } from "./seed/env.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// Must run AFTER loadEnvFile — before it, DATABASE_URL may be unset and the
// guard would refuse a perfectly good local target. Must run BEFORE
// `new PrismaClient()` so no client holding a remote connection string is ever
// constructed: that makes the refusal a property of control flow rather than a
// convention a later edit has to remember.
//
// The decision itself is in src/seed-permission.ts, where it can be sampled
// without running this script; what stays here is only the printing and the
// exiting.
const permission = resolveSeedPermission(process.env);

if (permission.kind === "refused") {
  console.error(permission.message);
  process.exit(1);
}

// Say where it wrote, on every run. The absence of a guard and the absence of
// any output compounded on 2026-09-07: either one alone would have made the
// seed's target visible before the rows landed.
console.log(permission.message);

const instanceName = process.env.EVOLUTION_INSTANCE_NAME ?? "select-lub-poc";
const prisma = new PrismaClient();

const unit =
  (await prisma.unit.findFirst({ where: { name: "Select Lub" } })) ??
  (await prisma.unit.create({ data: { name: "Select Lub" } }));

const unitB =
  (await prisma.unit.findFirst({ where: { name: "Select Lub 2" } })) ??
  (await prisma.unit.create({ data: { name: "Select Lub 2" } }));

const namedConnection = await prisma.whatsAppConnection.findUnique({ where: { instanceName } });
const baileysForUnit = namedConnection
  ? []
  : await prisma.whatsAppConnection.findMany({
      where: { unitId: unit.id, provider: "EVOLUTION_BAILEYS" },
    });
const plan = planWhatsAppConnectionSeed(namedConnection, baileysForUnit);
if (plan.action === "rename") {
  await prisma.whatsAppConnection.update({
    where: { id: plan.id },
    data: { instanceName },
  });
} else if (plan.action === "create") {
  await prisma.whatsAppConnection.create({
    data: {
      instanceName,
      unitId: unit.id,
      provider: "EVOLUTION_BAILEYS",
    },
  });
}

// Must be the Auth dashboard uuid for attendant-a (README: same string as the
// auto-login JWT's user id). Unset or a different uuid: login works, unit
// routes 403. This script does not check the match.
const seedA = process.env.SEED_USER_A_ID;
if (seedA) {
  await prisma.user.upsert({
    where: { id: seedA },
    create: { id: seedA, email: "attendant-a@selectlub.example", name: "Atendente A" },
    update: { email: "attendant-a@selectlub.example", name: "Atendente A" },
  });
  await prisma.userUnit.upsert({
    where: { userId_unitId: { userId: seedA, unitId: unit.id } },
    create: { userId: seedA, unitId: unit.id },
    update: {},
  });
}

const seedB = process.env.SEED_USER_B_ID;
if (seedB) {
  await prisma.user.upsert({
    where: { id: seedB },
    create: { id: seedB, email: "attendant-b@selectlub.example", name: "Atendente B" },
    update: { email: "attendant-b@selectlub.example", name: "Atendente B" },
  });
  await prisma.userUnit.upsert({
    where: { userId_unitId: { userId: seedB, unitId: unitB.id } },
    create: { userId: seedB, unitId: unitB.id },
    update: {},
  });
}

await seedCatalogItems(prisma);

if (isDemoSeedEnabled()) {
  const { seedDemoDataset } = await import("./seed/demo.js");
  await seedDemoDataset(prisma, {
    unitId: unit.id,
    unitBId: unitB.id,
    liveInstanceName: instanceName,
  });
}

await prisma.$disconnect();
