--============================================================================
-- Closing two ways around the immutability triggers
--
-- Migration 0017 says why these triggers exist: "the service layer is not the
-- only thing that ever writes to this table: a migration, a console, a later
-- feature or a bug can all reach the row directly." Against exactly that
-- caller, two of them cost one extra statement.
--
-- 1. `status` is mutable, and every other guard keys off `status = 'draft'`.
--    So `UPDATE invoice SET status='draft'` was accepted on a finalized row —
--    the row diff ignores a mutable column — and the *next* statement then
--    saw OLD.status = 'draft' and allowed everything: the number, the totals,
--    the frozen parties, the stored PDF, the positions, and finally DELETE.
--    Demotion is now refused outright. An invoice leaves `draft` once.
--
-- 2. The delete refusal keyed on the status alone. It now also refuses any
--    row that has ever been given a number, whatever its status says — the
--    number is the thing § 14 Abs. 4 Nr. 4 UStG requires to be gapless, so a
--    numbered row is a document and stays, § 147 AO.
--
-- 3. A line could be INSERTed into a finalized Rechnungskorrektur. 0017
--    argued this could not move a figure, because the note's own totals and
--    its stored PDF are immutable. It moves every figure of the XRechnung:
--    `loadCreditNote` recomputes the totals from these rows and the /xml
--    route renders from that, so an added line produced an XML that
--    contradicted the PDF the customer holds. An INSERT is now allowed only
--    while the parent note is still being written by this very transaction,
--    which is the one case 0017 needed it for.
--============================================================================

CREATE OR REPLACE FUNCTION "invoice_is_immutable"() RETURNS trigger AS $$
DECLARE
    mutable text[] := ARRAY[
        'status', 'paid_at', 'cancelled_at', 'sent_at',
        'credited_cents', 'updated_at',
        'pdf_key', 'pdf_sha256', 'pdf_bytes', 'pdf_rendered_at'
    ];
BEGIN
    -- A finalized invoice can never become a draft again. Without this the
    -- status column, being mutable, is the key to every other lock.
    IF OLD."status" <> 'draft' AND NEW."status" = 'draft' THEN
        RAISE EXCEPTION
            'Rechnung % ist ausgestellt und kann kein Entwurf mehr werden',
            coalesce(OLD."number", OLD."id")
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."status" = 'draft' THEN
        RETURN NEW;
    END IF;

    IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
        RAISE EXCEPTION
            'Rechnung % ist ausgestellt und darf nicht mehr geändert werden',
            coalesce(OLD."number", OLD."id")
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."pdf_key" IS NOT NULL AND NEW."pdf_key" IS DISTINCT FROM OLD."pdf_key" THEN
        RAISE EXCEPTION
            'Das gespeicherte Dokument der Rechnung % darf nicht ersetzt werden',
            coalesce(OLD."number", OLD."id")
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- The number, not the status, is what makes a row a document.
CREATE OR REPLACE FUNCTION "invoice_delete_is_refused"() RETURNS trigger AS $$
BEGIN
    IF OLD."status" <> 'draft' OR OLD."number" IS NOT NULL THEN
        RAISE EXCEPTION
            'Rechnung % ist ausgestellt und darf nicht gelöscht werden (§ 147 AO)',
            coalesce(OLD."number", OLD."id")
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Same for the positions: a row belonging to a numbered invoice is part of a
-- document even if somebody has managed to put the parent's status back.
CREATE OR REPLACE FUNCTION "invoice_item_follows_invoice"() RETURNS trigger AS $$
DECLARE
    parent text;
    state text;
    issued text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        parent := OLD."invoice_id";
    ELSE
        parent := NEW."invoice_id";
    END IF;

    SELECT "status"::text, "number" INTO state, issued
      FROM "invoice" WHERE "id" = parent;

    IF state IS NOT NULL AND (state <> 'draft' OR issued IS NOT NULL) THEN
        RAISE EXCEPTION
            'Die Positionen der ausgestellten Rechnung % dürfen nicht geändert werden',
            parent
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

/*
 * A credit note's lines may only be written while the note itself is still
 * being created. `pg_current_xact_id()::xid` compared against the parent
 * row's `xmin` is exactly that test: the parent is visible to this
 * transaction and was written by it, so it has not been committed yet. Once
 * it has, the note is a document and its positions are part of it.
 */
CREATE OR REPLACE FUNCTION "credit_note_item_is_immutable"() RETURNS trigger AS $$
DECLARE
    born xid;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT "xmin" INTO born
          FROM "credit_note" WHERE "id" = NEW."credit_note_id";

        IF born IS NOT NULL AND born = pg_current_xact_id()::xid THEN
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION
        'Die Positionen einer Rechnungskorrektur dürfen nicht geändert werden'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "credit_note_item_immutable" ON "credit_note_item";--> statement-breakpoint
CREATE TRIGGER "credit_note_item_immutable"
    BEFORE INSERT OR UPDATE OR DELETE ON "credit_note_item"
    FOR EACH ROW EXECUTE FUNCTION "credit_note_item_is_immutable"();
