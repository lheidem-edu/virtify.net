import { toNextJsHandler } from "better-auth/next-js";
import { staffAuth } from "@/server/auth/staff-auth";

export const { GET, POST } = toNextJsHandler(staffAuth.handler);
