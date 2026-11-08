"use client";

import { useState } from "react";

/**
 * How a message's body is shown.
 *
 * The HTML goes into `<iframe sandbox srcdoc=…>` **without** `allow-scripts`
 * and **without** `allow-same-origin`. That pair is what actually protects
 * the page: the browser refuses to run script in there, and the frame has an
 * opaque origin, so nothing in a customer's mail can reach this document,
 * its cookies or its session. `sanitizeHtml` ran before the body was stored
 * and is the second layer, written in the knowledge that a hand-rolled
 * sanitiser always has holes.
 *
 * The stripped text is what is shown by default, because that is the part
 * somebody actually wrote. "Original anzeigen" is always there, because
 * stripping is a guess about somebody else's mail client and the part it
 * removed is occasionally the part that matters.
 */
export default function MessageBody({
    displayText,
    displayHtml,
    originalHtml,
}: {
    displayText: string;
    displayHtml: string | null;
    originalHtml: string | null;
}) {
    const [showOriginal, setShowOriginal] = useState(false);
    const html = showOriginal ? originalHtml : displayHtml;
    const hasOriginal = Boolean(originalHtml) && originalHtml !== displayHtml;

    return (
        <div className="mt-3 space-y-2">
            {html ? (
                <iframe
                    // No allow-scripts, no allow-same-origin. See the header.
                    sandbox=""
                    title="Nachricht"
                    srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#18181b;background:#fff;word-break:break-word;}img{max-width:100%;height:auto;}</style>${html}`}
                    className="h-80 w-full rounded-md border bg-white"
                />
            ) : (
                <pre className="whitespace-pre-wrap font-sans text-sm leading-6">
                    {showOriginal ? displayText : displayText}
                </pre>
            )}

            {hasOriginal ? (
                <button
                    type="button"
                    onClick={() => setShowOriginal((value) => !value)}
                    className="text-xs text-muted-foreground underline"
                >
                    {showOriginal
                        ? "Gekürzt anzeigen"
                        : "Original mit Verlauf anzeigen"}
                </button>
            ) : null}
        </div>
    );
}
