import { site } from "@/lib/site";

const dot = site.name.lastIndexOf(".");
const stem = site.name.slice(0, dot);
const tld = site.name.slice(dot);

/**
 * The site name with the TLD set back a shade. Inherits type from its parent,
 * so the header and the footer can size it differently. Inside a `.group`
 * ancestor the TLD lifts on hover.
 */
export default function Wordmark() {
    return (
        <>
            {stem}
            <span className="text-zinc-500 transition-colors group-hover:text-zinc-300">
                {tld}
            </span>
        </>
    );
}
