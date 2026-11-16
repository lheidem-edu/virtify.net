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
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                {...props}
            >
                {children}
            </Link>
        </li>
    );
}
