/**
 * One file per domain, re-exported here so `import { invoice } from "@/db/schema"`
 * keeps working and Drizzle sees the whole schema in one object.
 */

export * from "./auth";
export * from "./contracts";
export * from "./invoices";
export * from "./legal";
export * from "./offers";
export * from "./payments";
export * from "./settings";
export * from "./staff";
