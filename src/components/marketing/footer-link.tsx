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
                className="text-sm text-zinc-400 transition-colors hover:text-white"
                {...props}
            >
                {children}
            </Link>
        </li>
    );
}
