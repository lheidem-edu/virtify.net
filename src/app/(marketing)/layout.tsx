import SiteChrome from "@/components/marketing/site-chrome";

export default function SiteLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <SiteChrome>{children}</SiteChrome>;
}
