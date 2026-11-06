import { site } from "@/lib/site";

/**
 * The site name with the TLD set back a shade. Inherits type from its parent,
 * so the header and the footer can size it differently. Inside a `.group`
 * ancestor the TLD lifts on hover.
 *
 * The name is a prop because it is editable; the built-in one is the default
 * so a client component that has none still renders something sensible.
 */
export default function Wordmark({ name = site.name }: { name?: string }) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const tld = dot > 0 ? name.slice(dot) : "";

    return (
        <>
            {stem}
            <span className="text-zinc-500 transition-colors group-hover:text-zinc-300">
                {tld}
            </span>
        </>
    );
}
