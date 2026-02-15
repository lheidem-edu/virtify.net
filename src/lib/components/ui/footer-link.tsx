import Link from "next/link";

export default function FooterLink({
    href,
    children,
    ...props
}: {
    href: string;
    children: React.ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    return (
        <li>
            <Link
                href={href}
                className="text-zinc-400 hover:text-zinc-200 text-sm"
                {...props}
            >
                {children}
            </Link>
        </li>
    );
}
