import Image from "next/image";
import netmountainsLogo from "@/lib/assets/netmountains-logo.png";
import { operator } from "@/lib/site";

const properties = [
    {
        label: "01",
        title: "Vollvirtualisierung",
        body: "KVM unter Proxmox VE: eigener Kernel, eigenes Betriebssystem, volle Root-Rechte auf der Instanz.",
    },
    {
        label: "02",
        title: "Eigene Adressen",
        body: "Jede KVM-Instanz erhält eigene IPv4- und IPv6-Adressen aus dem Adressraum von virtify.net.",
    },
    {
        label: "03",
        title: "Selbstverwaltung",
        body: "Nach Fertigstellung der Plattform lassen sich Instanzen direkt im Web-Interface konfigurieren. Bis dahin richten wir sie für dich ein.",
    },
];

export default function Page() {
    return (
        <>
            <section className="border-b px-6 py-20 md:px-10 md:py-28">
                <h2 className="max-w-4xl text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
                    KVM-Instanzen
                </h2>
                <p className="mt-8 max-w-2xl text-lg text-zinc-300">
                    Virtuelle Maschinen unter Proxmox VE, betrieben auf eigener
                    Hardware.
                </p>
                <p className="mt-4 max-w-2xl text-zinc-500">
                    Die Plattform befindet sich in Entwicklung. Instanzen
                    richten wir derzeit auf Anfrage ein.
                </p>
            </section>

            <section className="grid border-b sm:grid-cols-3">
                {properties.map((property) => (
                    <div
                        key={property.label}
                        className="border-t p-6 first:border-t-0 sm:border-t-0 sm:border-l sm:p-10 sm:first:border-l-0"
                    >
                        <p className="font-mono text-xs text-zinc-600">
                            {property.label}
                        </p>
                        <h3 className="mt-6 text-sm font-medium tracking-tight">
                            {property.title}
                        </h3>
                        <p className="mt-3 text-sm leading-6 text-zinc-500">
                            {property.body}
                        </p>
                    </div>
                ))}
            </section>

            <section className="grid gap-x-12 gap-y-8 border-b px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    Rechenzentrum
                </h2>
                <div className="max-w-xl">
                    <Image
                        src={netmountainsLogo}
                        alt="NETMOUNTAINS"
                        priority={false}
                        className="h-8 w-auto sm:h-9"
                    />
                    <p className="mt-8 text-sm leading-7 text-zinc-400">
                        Unsere Server stehen im Rechenzentrum der NETMOUNTAINS
                        Group GmbH in Velbert. Gebäude, Stromversorgung, Kühlung
                        und Zutrittskontrolle liegen dort — Hardware, Hypervisor
                        und der Betrieb der Instanzen bei uns.
                    </p>
                    <a
                        href="https://netmountains.de"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-6 inline-block text-sm text-zinc-400 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-white hover:decoration-white"
                    >
                        netmountains.de
                    </a>
                </div>
            </section>

            <section className="grid gap-x-12 gap-y-8 px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    Anfrage
                </h2>
                <div className="max-w-xl">
                    <p className="text-sm leading-7 text-zinc-400">
                        Konkrete Projekte besprechen wir direkt. Schreib uns,
                        welche Konfiguration du brauchst — vCPU,
                        Arbeitsspeicher, Speicher und Anbindung.
                    </p>
                    <a
                        href={`mailto:${operator.email}`}
                        className="mt-8 inline-block border px-5 py-3 text-sm transition-colors hover:border-white hover:bg-white hover:text-black"
                    >
                        {operator.email}
                    </a>
                </div>
            </section>
        </>
    );
}
