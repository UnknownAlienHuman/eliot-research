import type { TableSpec } from "./backup-table-spec-types.js";
import { DURABLE_CORE_TABLE_SPECS_A } from "./core-table-specs-a.js";
import { DURABLE_CORE_TABLE_SPECS_B } from "./core-table-specs-b.js";
import { DURABLE_CORE_TABLE_SPECS_C } from "./core-table-specs-c.js";
import { DURABLE_CORE_TABLE_SPECS_D } from "./core-table-specs-d.js";
import { DURABLE_CORE_TABLE_SPECS_E } from "./core-table-specs-e.js";
import { DURABLE_CORE_TABLE_SPECS_F } from "./core-table-specs-f.js";

// Combined inventory is split into bounded files to keep each table
// specification reviewable while still enforcing one exhaustive export gate.
export const DURABLE_CORE_TABLE_SPECS: readonly TableSpec[] = [...DURABLE_CORE_TABLE_SPECS_A, ...DURABLE_CORE_TABLE_SPECS_B, ...DURABLE_CORE_TABLE_SPECS_C, ...DURABLE_CORE_TABLE_SPECS_D, ...DURABLE_CORE_TABLE_SPECS_E, ...DURABLE_CORE_TABLE_SPECS_F];
