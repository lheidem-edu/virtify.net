import "server-only";

/**
 * An invited employee gets the same link a forgotten password produces —
 * Better Auth has one reset flow and one callback, and that callback is handed
 * nothing but the user and the URL. This carries the two things across it that
 * the invitation needs: that the link being sent is an invitation rather than
 * a forgotten password, and whether the mail actually went out.
 *
 * The second half matters because Better Auth awaits the callback but swallows
 * what it throws — requestPasswordReset answers "status: true" whether or not
 * anything was sent, which is right for a public reset form (it must not
 * confirm that an address exists) and wrong for an invitation, where the
 * operator has to know it failed.
 *
 * Nothing here is persisted: the mark is made and taken inside one request,
 * and one that outlived it would relabel a real reset mail weeks later.
 */

type Invite = { sent: boolean; error?: unknown };

const invites = new Map<string, Invite>();

const key = (email: string) => email.trim().toLowerCase();

export function beginInvite(email: string) {
    invites.set(key(email), { sent: false });
}

/** True while an invitation for this address is being sent. */
export function isInvite(email: string) {
    return invites.has(key(email));
}

export function recordInvite(email: string, error?: unknown) {
    const invite = invites.get(key(email));

    if (invite) {
        invite.sent = error === undefined;
        invite.error = error;
    }
}

/** The outcome, and the end of the mark. */
export function endInvite(email: string): Invite {
    const invite = invites.get(key(email)) ?? { sent: false };
    invites.delete(key(email));
    return invite;
}
