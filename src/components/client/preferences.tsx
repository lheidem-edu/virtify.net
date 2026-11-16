"use client";

import { Check, Languages, Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
    type PreferenceState,
    setLocale,
    setTheme,
} from "@/app/(client)/client/preferences/actions";
import { LOCALE_NAMES, LOCALES, type Locale } from "@/i18n/locale";
import { THEMES, type Theme } from "@/lib/theme";

/**
 * The language and appearance switchers in the portal's sidebar.
 *
 * Buttons in a form rather than a `<select>` with an `onChange`: the choice is
 * a server action that writes a cookie *and*, for the language, the account's
 * own field, and a form posts it without any client state to get out of sync
 * with what the server decided. The page re-renders in the new language
 * because the action revalidates the layout.
 *
 * No optimistic update. Switching to English and seeing German for 200ms is a
 * better experience than seeing English and finding out the account was not
 * saved.
 */

const THEME_ICON: Record<Theme, typeof Sun> = {
    system: Monitor,
    light: Sun,
    dark: Moon,
};

function Row({
    children,
    label,
    icon: Icon,
}: {
    children: React.ReactNode;
    label: string;
    icon: typeof Sun;
}) {
    return (
        <div className="space-y-1 px-2 py-1">
            <p className="flex items-center gap-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                <Icon className="size-3.5" />
                {label}
            </p>
            <div className="flex gap-1 group-data-[collapsible=icon]:hidden">
                {children}
            </div>
        </div>
    );
}

export function LanguageSwitcher({ current }: { current: Locale }) {
    const t = useTranslations("portal.language");
    const [, formAction, pending] = useActionState<PreferenceState, FormData>(
        setLocale,
        { status: "idle" },
    );

    return (
        <Row label={t("label")} icon={Languages}>
            {LOCALES.map((locale) => (
                <form key={locale} action={formAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <button
                        type="submit"
                        disabled={pending || locale === current}
                        aria-current={locale === current}
                        className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-100 ${
                            locale === current
                                ? "border-ring"
                                : "text-muted-foreground hover:border-ring"
                        }`}
                    >
                        {locale === current ? (
                            <Check className="size-3" />
                        ) : null}
                        {LOCALE_NAMES[locale]}
                    </button>
                </form>
            ))}
        </Row>
    );
}

export function ThemeSwitcher({ current }: { current: Theme }) {
    const t = useTranslations("portal.theme");
    const [, formAction, pending] = useActionState<PreferenceState, FormData>(
        setTheme,
        { status: "idle" },
    );

    return (
        <Row label={t("label")} icon={THEME_ICON[current]}>
            {THEMES.map((theme) => {
                const Icon = THEME_ICON[theme];

                return (
                    <form key={theme} action={formAction}>
                        <input type="hidden" name="theme" value={theme} />
                        <button
                            type="submit"
                            disabled={pending || theme === current}
                            aria-current={theme === current}
                            aria-label={t(theme)}
                            title={t(theme)}
                            className={`flex items-center rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-100 ${
                                theme === current
                                    ? "border-ring"
                                    : "text-muted-foreground hover:border-ring"
                            }`}
                        >
                            <Icon className="size-3.5" />
                        </button>
                    </form>
                );
            })}
        </Row>
    );
}
