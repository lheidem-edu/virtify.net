import type { Metadata } from "next";
import { loadSettings } from "@/lib/settings";
import CancellationForm from "./cancellation-form";

export async function generateMetadata(): Promise<Metadata> {
    const { site } = await loadSettings();

    return {
        title: "Vertrag kündigen",
        description: `Verträge mit ${site.name} online kündigen — die Schaltfläche nach § 312k BGB.`,
    };
}

export default async function Page() {
    const { site } = await loadSettings();

    return <CancellationForm siteName={site.name} />;
}
