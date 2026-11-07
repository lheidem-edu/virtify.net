/**
 * One file per domain, re-exported here so `import { invoice } from "@/db/schema"`
 * keeps working and Drizzle sees the whole schema in one object.
 */

export * from "./api-keys";
export * from "./audit";
export * from "./auth";
export * from "./catalog";
export * from "./contracts";
export * from "./customers";
export * from "./invoices";
export * from "./legal";
export * from "./offers";
export * from "./payments";
export * from "./settings";
export * from "./staff";
export * from "./tax";
