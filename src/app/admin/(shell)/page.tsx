import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/staff-session";

export default async function Page() {
    await requireStaff();
    redirect("/admin/customers");
}
