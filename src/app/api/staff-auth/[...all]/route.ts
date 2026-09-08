import { toNextJsHandler } from "better-auth/next-js";
import { staffAuth } from "@/lib/staff-auth";

export const { GET, POST } = toNextJsHandler(staffAuth.handler);
