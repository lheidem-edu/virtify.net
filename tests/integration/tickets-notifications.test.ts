import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashToken } from "@/lib/crypto";
import {
    markNotificationFailed,
    markNotificationHandled,
    pendingNotifications,
    pruneNotifications,
    recordNotification,
} from "@/server/tickets/claim";
import {
    acceptNotifications,
    idFromResource,
    notificationSchema,
} from "@/server/tickets/notifications";
import { syncSubscriptions } from "@/server/tickets/subscriptions";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";
import { makeDepartment } from "../helpers/fixtures";
import { fakeChannel } from "../helpers/graph";

/**
 * The webhook's side of things.
 *
 * `clientState` is this route's **authorization** — an unauthenticated route
 * has nothing else, exactly as the Stripe route has only its signature. The
 * cases that matter are the refusals, and the one that matters most is that
 * a refused entry leaves no row behind: a forged notification must not be
 * able to make the worker go and look at something.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the notification proofs are being\n" +
            "        SKIPPED. Run `npm run db:up`.\n",
    );
}

const MAILBOX = "support@example.test";
const SECRET = "the-client-state-we-minted";

function envelope(
    over: Partial<{
        subscriptionId: string;
        clientState: string | null;
        changeType: string;
        resourceId: string | null;
        resource: string | null;
    }> = {},
) {
    return notificationSchema.parse({
        value: [
            {
                subscriptionId: over.subscriptionId ?? "sub-1",
                clientState:
                    over.clientState === undefined ? SECRET : over.clientState,
                changeType: over.changeType ?? "created",
                resource: over.resource ?? null,
                resourceData:
                    over.resourceId === null
                        ? null
                        : { id: over.resourceId ?? "AAMk-new" },
                tenantId: "tenant",
            },
        ],
    });
}

describe.skipIf(!available)("graph change notifications", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const created = await createTestDatabase();

        db = created.db;
        drop = created.drop;

        await makeDepartment(db, { mailbox: MAILBOX });

        await db.insert(schema.mailSubscription).values({
            channel: "msgraph",
            mailbox: MAILBOX,
            resource: `/users/${MAILBOX}/mailFolders('inbox')/messages`,
            subscriptionId: "sub-1",
            clientStateHash: hashToken(SECRET),
            expiresAt: new Date(Date.now() + 3_600_000),
        });
    });

    afterAll(async () => {
        await drop();
    });

    it("records a notification whose clientState matches", async () => {
        expect(await acceptNotifications(db, envelope())).toEqual({
            accepted: 1,
            rejected: 0,
        });

        const rows = await db
            .select()
            .from(schema.mailNotification)
            .where(eq(schema.mailNotification.resourceId, "AAMk-new"));

        expect(rows).toHaveLength(1);
        expect(rows[0].mailbox).toBe(MAILBOX);
        expect(rows[0].handledAt).toBeNull();
    });

    it("refuses a wrong clientState and writes nothing at all", async () => {
        const before = await db.select().from(schema.mailNotification);

        expect(
            await acceptNotifications(
                db,
                envelope({
                    clientState: "guessed",
                    resourceId: "AAMk-forged",
                }),
            ),
        ).toEqual({ accepted: 0, rejected: 1 });

        const after = await db.select().from(schema.mailNotification);

        expect(after).toHaveLength(before.length);
        expect(after.some((row) => row.resourceId === "AAMk-forged")).toBe(
            false,
        );
    });

    it("refuses a missing clientState", async () => {
        expect(
            await acceptNotifications(
                db,
                envelope({ clientState: null, resourceId: "AAMk-none" }),
            ),
        ).toEqual({ accepted: 0, rejected: 1 });
    });

    it("refuses a subscription we never created", async () => {
        expect(
            await acceptNotifications(
                db,
                envelope({
                    subscriptionId: "sub-nobody-made",
                    resourceId: "AAMk-nobody",
                }),
            ),
        ).toEqual({ accepted: 0, rejected: 1 });
    });

    it("refuses a subscription we have since removed", async () => {
        await db.insert(schema.mailSubscription).values({
            channel: "msgraph",
            mailbox: MAILBOX,
            resource: "x",
            subscriptionId: "sub-removed",
            clientStateHash: hashToken(SECRET),
            expiresAt: new Date(Date.now() + 3_600_000),
            removedAt: new Date(),
        });

        expect(
            await acceptNotifications(
                db,
                envelope({
                    subscriptionId: "sub-removed",
                    resourceId: "AAMk-removed",
                }),
            ),
        ).toEqual({ accepted: 0, rejected: 1 });
    });

    it("keeps the good entries of a batch that also holds a forged one", async () => {
        const mixed = notificationSchema.parse({
            value: [
                {
                    subscriptionId: "sub-1",
                    clientState: SECRET,
                    changeType: "created",
                    resourceData: { id: "AAMk-good" },
                },
                {
                    subscriptionId: "sub-1",
                    clientState: "wrong",
                    changeType: "created",
                    resourceData: { id: "AAMk-bad" },
                },
            ],
        });

        expect(await acceptNotifications(db, mixed)).toEqual({
            accepted: 1,
            rejected: 1,
        });

        const rows = await db.select().from(schema.mailNotification);

        expect(rows.some((row) => row.resourceId === "AAMk-good")).toBe(true);
        expect(rows.some((row) => row.resourceId === "AAMk-bad")).toBe(false);
    });

    it("collapses a burst for one message into one pending row", async () => {
        for (let i = 0; i < 5; i += 1) {
            await acceptNotifications(
                db,
                envelope({ resourceId: "AAMk-burst" }),
            );
        }

        const rows = await db
            .select()
            .from(schema.mailNotification)
            .where(eq(schema.mailNotification.resourceId, "AAMk-burst"));

        expect(rows).toHaveLength(1);
    });

    it("reopens a handled row when the message changes again", async () => {
        await recordNotification(db, {
            channel: "msgraph",
            mailbox: MAILBOX,
            subscriptionId: "sub-1",
            resourceId: "AAMk-again",
            changeType: "created",
        });

        const [row] = await db
            .select()
            .from(schema.mailNotification)
            .where(eq(schema.mailNotification.resourceId, "AAMk-again"));

        await markNotificationHandled(db, row.id);

        await recordNotification(db, {
            channel: "msgraph",
            mailbox: MAILBOX,
            subscriptionId: "sub-1",
            resourceId: "AAMk-again",
            changeType: "updated",
        });

        const [reopened] = await db
            .select()
            .from(schema.mailNotification)
            .where(eq(schema.mailNotification.resourceId, "AAMk-again"));

        expect(reopened.handledAt).toBeNull();
        expect(reopened.changeType).toBe("updated");
        expect(reopened.id).toBe(row.id);
    });

    it("leaves a failed notification pending, with the failure on it", async () => {
        await recordNotification(db, {
            channel: "msgraph",
            mailbox: MAILBOX,
            subscriptionId: "sub-1",
            resourceId: "AAMk-fails",
            changeType: "created",
        });

        const [row] = await db
            .select()
            .from(schema.mailNotification)
            .where(eq(schema.mailNotification.resourceId, "AAMk-fails"));

        await markNotificationFailed(db, row.id, "Graph said no");

        const [after] = await db
            .select()
            .from(schema.mailNotification)
            .where(eq(schema.mailNotification.id, row.id));

        // Still pending: a failure that reads as a success is the mistake
        // `claimEvent` was written to avoid.
        expect(after.handledAt).toBeNull();
        expect(after.attempts).toBe(1);
        expect(after.lastError).toBe("Graph said no");

        const pending = await pendingNotifications(db, 100);

        expect(pending.some((entry) => entry.id === row.id)).toBe(true);
    });

    it("prunes only what has been handled, and only once it is old", async () => {
        await recordNotification(db, {
            channel: "msgraph",
            mailbox: MAILBOX,
            subscriptionId: "sub-1",
            resourceId: "AAMk-old",
            changeType: "created",
        });

        const [row] = await db
            .select()
            .from(schema.mailNotification)
            .where(eq(schema.mailNotification.resourceId, "AAMk-old"));

        await db
            .update(schema.mailNotification)
            .set({ handledAt: new Date("2020-01-01T00:00:00Z") })
            .where(eq(schema.mailNotification.id, row.id));

        const pendingBefore = (await pendingNotifications(db, 100)).length;

        expect(
            await pruneNotifications(db, new Date("2021-01-01T00:00:00Z")),
        ).toBe(1);

        // Nothing pending was touched.
        expect((await pendingNotifications(db, 100)).length).toBe(
            pendingBefore,
        );
    });

    it("reads a message id out of `resource` when resourceData is absent", () => {
        expect(idFromResource("Users/abc/Messages/AAMkAGI2THVS")).toBe(
            "AAMkAGI2THVS",
        );
        expect(idFromResource(null)).toBeNull();
        expect(idFromResource("Users/abc")).toBeNull();
    });
});

describe.skipIf(!available)("subscription lifecycle", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const created = await createTestDatabase();

        db = created.db;
        drop = created.drop;

        await makeDepartment(db, { mailbox: MAILBOX });
    });

    afterAll(async () => {
        await drop();
    });

    it("creates one, stores only the hash of its secret, and does not re-create it", async () => {
        const channel = fakeChannel();
        const url = "https://virtify.test/api/webhooks/msgraph";

        const first = await syncSubscriptions(db, channel, {
            notificationUrl: url,
        });

        expect(first.created).toEqual([MAILBOX]);
        expect(first.failed).toEqual([]);

        const [row] = await db.select().from(schema.mailSubscription);

        // The secret is 32 bytes base64url; the row holds a 64-char hash.
        expect(row.clientStateHash).toMatch(/^[0-9a-f]{64}$/);

        const again = await syncSubscriptions(db, channel, {
            notificationUrl: url,
        });

        expect(again.created).toEqual([]);
        expect(again.renewed).toEqual([]);
        expect(channel.subscriptions).toHaveLength(1);
    });

    it("renews one that is about to lapse, and not one that is not", async () => {
        const channel = fakeChannel();
        const url = "https://virtify.test/api/webhooks/msgraph";

        await syncSubscriptions(db, channel, { notificationUrl: url });

        const [row] = await db.select().from(schema.mailSubscription);

        await db
            .update(schema.mailSubscription)
            .set({ expiresAt: new Date(Date.now() + 60 * 60_000) })
            .where(eq(schema.mailSubscription.id, row.id));

        const renewed = await syncSubscriptions(db, channel, {
            notificationUrl: url,
        });

        expect(renewed.renewed).toEqual([MAILBOX]);
        expect(channel.renewCount).toBe(1);

        const quiet = await syncSubscriptions(db, channel, {
            notificationUrl: url,
        });

        expect(quiet.renewed).toEqual([]);
        expect(channel.renewCount).toBe(1);
    });

    it("marks a subscription Graph has forgotten as removed, so the next pass creates one", async () => {
        const channel = fakeChannel();
        const url = "https://virtify.test/api/webhooks/msgraph";

        await syncSubscriptions(db, channel, { notificationUrl: url });

        const live = (await db.select().from(schema.mailSubscription)).filter(
            (entry) => entry.removedAt === null,
        );

        await db
            .update(schema.mailSubscription)
            .set({ expiresAt: new Date(Date.now() + 60_000) })
            .where(eq(schema.mailSubscription.id, live[0].id));

        const gone = Object.assign(new Error("gone"), { status: 404 });

        channel.renewSubscription = async () => {
            throw gone;
        };

        const failed = await syncSubscriptions(db, channel, {
            notificationUrl: url,
        });

        expect(failed.failed).toHaveLength(1);

        const [after] = await db
            .select()
            .from(schema.mailSubscription)
            .where(eq(schema.mailSubscription.id, live[0].id));

        // Marked removed rather than patched for ever.
        expect(after.removedAt).not.toBeNull();

        const fresh = fakeChannel();
        const recreated = await syncSubscriptions(db, fresh, {
            notificationUrl: url,
        });

        expect(recreated.created).toEqual([MAILBOX]);
    });

    it("removes a subscription whose department was switched off", async () => {
        const channel = fakeChannel();
        const url = "https://virtify.test/api/webhooks/msgraph";

        await syncSubscriptions(db, channel, { notificationUrl: url });

        await db
            .update(schema.ticketDepartment)
            .set({ active: false })
            .where(eq(schema.ticketDepartment.mailbox, MAILBOX));

        const report = await syncSubscriptions(db, channel, {
            notificationUrl: url,
        });

        expect(report.removed).toEqual([MAILBOX]);
        expect(channel.deleted.length).toBeGreaterThan(0);

        await db
            .update(schema.ticketDepartment)
            .set({ active: true })
            .where(eq(schema.ticketDepartment.mailbox, MAILBOX));
    });
});

/**
 * The route itself. It does two things and must do no third: answer the
 * validation handshake, and record what the clientState check lets through.
 */
describe.skipIf(!available)("/api/webhooks/msgraph", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let post: (request: Request) => Promise<Response>;
    let get: (request: Request) => Promise<Response>;

    const URL_BASE = "https://virtify.test/api/webhooks/msgraph";

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        process.env.DATABASE_URL = db.$pool.options.connectionString as string;
        delete (globalThis as { pool?: unknown }).pool;
        vi.resetModules();

        const route = await import("@/app/api/webhooks/msgraph/route");

        post = route.POST;
        get = route.GET;

        await makeDepartment(db, { mailbox: MAILBOX });

        await db.insert(schema.mailSubscription).values({
            channel: "msgraph",
            mailbox: MAILBOX,
            resource: "x",
            subscriptionId: "sub-route",
            clientStateHash: hashToken(SECRET),
            expiresAt: new Date(Date.now() + 3_600_000),
        });
    });

    afterAll(async () => {
        const { db: appDb } = await import("@/db");

        await (
            appDb as unknown as { $client: { end(): Promise<void> } }
        ).$client.end();

        await drop();
    });

    const body = (clientState: string, resourceId: string) =>
        new Request(URL_BASE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                value: [
                    {
                        subscriptionId: "sub-route",
                        clientState,
                        changeType: "created",
                        resourceData: { id: resourceId },
                    },
                ],
            }),
        });

    it("echoes the validation token verbatim, as text/plain", async () => {
        const token = "Validation: Testing client application reachability";
        const response = await post(
            new Request(
                `${URL_BASE}?validationToken=${encodeURIComponent(token)}`,
                { method: "POST" },
            ),
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(await response.text()).toBe(token);

        // Some tooling validates with a GET; answering costs nothing.
        const viaGet = await get(
            new Request(
                `${URL_BASE}?validationToken=${encodeURIComponent(token)}`,
            ),
        );

        expect(await viaGet.text()).toBe(token);
    });

    it("answers the handshake before it looks at anything else", async () => {
        // No body at all, which is what Graph sends with the token.
        const response = await post(
            new Request(`${URL_BASE}?validationToken=abc`, { method: "POST" }),
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("abc");
    });

    it("records a notification whose clientState is right", async () => {
        const response = await post(body(SECRET, "AAMk-route-good"));

        expect(response.status).toBe(202);

        const rows = await db
            .select()
            .from(schema.mailNotification)
            .where(eq(schema.mailNotification.resourceId, "AAMk-route-good"));

        expect(rows).toHaveLength(1);
    });

    it("answers 202 for a forged one and records nothing", async () => {
        const response = await post(body("guessed", "AAMk-route-bad"));

        /**
         * 202, not 400. Graph retries a non-2xx for hours and then disables
         * the subscription: a forged delivery must not be able to do that
         * to a real one.
         */
        expect(response.status).toBe(202);

        const rows = await db
            .select()
            .from(schema.mailNotification)
            .where(eq(schema.mailNotification.resourceId, "AAMk-route-bad"));

        expect(rows).toHaveLength(0);
    });

    it("refuses a body that is not a notification envelope", async () => {
        const broken = await post(
            new Request(URL_BASE, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{not json",
            }),
        );

        expect(broken.status).toBe(400);

        const wrongShape = await post(
            new Request(URL_BASE, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ value: [{ nothing: true }] }),
            }),
        );

        expect(wrongShape.status).toBe(400);
    });
});
