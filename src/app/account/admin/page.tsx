import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-session";

export default async function Page() {
    await requireAdmin();
    redirect("/account/admin/customers");
}
