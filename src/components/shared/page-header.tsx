export default function PageHeader({
    title,
    intro,
    action,
}: {
    title: string;
    intro?: string;
    action?: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-4 border-b px-6 py-10 md:flex-row md:items-start md:justify-between md:px-10 md:py-12">
            <div>
                <h1 className="text-2xl font-semibold tracking-tight">
                    {title}
                </h1>
                {intro ? (
                    <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
                        {intro}
                    </p>
                ) : null}
            </div>
            {action ? <div className="shrink-0">{action}</div> : null}
        </div>
    );
}
