/**
 * CLI smoke script: resolves a fixed PEUGEOT 207 example and prints JSON to stdout.
 */

import { resolveOil } from "../../src/kernel/clients/motul/resolver.js";

const result = await resolveOil({
  brand: "PEUGEOT",
  year: "2011",
  model: "207 / Passion / SW",
  submodel: "1.4i 8V - TU3",
});

console.log(JSON.stringify(result, null, 2));
