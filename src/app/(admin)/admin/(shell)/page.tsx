import { redirect } from "next/navigation";
import { requireStaff } from "@/server/auth/staff-session";

export default async function Page() {
    await requireStaff();
    redirect("/admin/customers");
}
