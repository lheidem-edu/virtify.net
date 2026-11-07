ALTER TABLE "invoice" DROP COLUMN "cancels_invoice_id";--> statement-breakpoint
--============================================================================
-- Immutability, enforced by the database
--
-- CLAUDE.md rule 3 says a finalized invoice is never changed. The service
-- layer refuses it, but the service layer is not the only thing that ever
-- writes to this table: a migration, a console, a later feature or a bug can
-- all reach the row directly. So the rule is also here, where everything has
-- to pass.
--
-- Three facts are still allowed to change after finalization, because they
-- are about the invoice rather than statements on it: whether it has been
-- paid, how much of it a correction has taken back, and when a copy was
-- mailed. The reference to the stored PDF may be set once, from nothing to
-- something, and never swapped afterwards.
--
-- The comparison is "the whole row minus those columns", not a list of the
-- ones that matter. A column added later is therefore immutable by default,
-- which is the direction a mistake should fall in.
--============================================================================

CREATE OR REPLACE FUNCTION "invoice_is_immutable"() RETURNS trigger AS $$
DECLARE
    mutable text[] := ARRAY[
        'status', 'paid_at', 'cancelled_at', 'sent_at',
        'credited_cents', 'updated_at',
        'pdf_key', 'pdf_sha256', 'pdf_bytes', 'pdf_rendered_at'
    ];
BEGIN
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

CREATE OR REPLACE FUNCTION "invoice_delete_is_refused"() RETURNS trigger AS $$
BEGIN
    IF OLD."status" <> 'draft' THEN
        RAISE EXCEPTION
            'Rechnung % ist ausgestellt und darf nicht gelöscht werden (§ 147 AO)',
            coalesce(OLD."number", OLD."id")
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- The positions of a finalized invoice are part of the document. The lookup
-- finds no row when the parent is being deleted by a cascade, which only
-- happens for a draft — a finalized invoice cannot be deleted at all.
CREATE OR REPLACE FUNCTION "invoice_item_follows_invoice"() RETURNS trigger AS $$
DECLARE
    parent text;
    state text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        parent := OLD."invoice_id";
    ELSE
        parent := NEW."invoice_id";
    END IF;

    SELECT "status"::text INTO state FROM "invoice" WHERE "id" = parent;

    IF state IS NOT NULL AND state <> 'draft' THEN
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

-- A credit note has no draft state: it is created finalized, so everything
-- but the same three facts is immutable from the first commit.
CREATE OR REPLACE FUNCTION "credit_note_is_immutable"() RETURNS trigger AS $$
DECLARE
    mutable text[] := ARRAY[
        'sent_at', 'updated_at',
        'pdf_key', 'pdf_sha256', 'pdf_bytes', 'pdf_rendered_at'
    ];
BEGIN
    IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
        RAISE EXCEPTION
            'Die Rechnungskorrektur % darf nicht geändert werden',
            OLD."number"
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."pdf_key" IS NOT NULL AND NEW."pdf_key" IS DISTINCT FROM OLD."pdf_key" THEN
        RAISE EXCEPTION
            'Das gespeicherte Dokument der Rechnungskorrektur % darf nicht ersetzt werden',
            OLD."number"
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "credit_note_delete_is_refused"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'Die Rechnungskorrektur % darf nicht gelöscht werden (§ 147 AO)',
        OLD."number"
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- The lines of a credit note are written in the same transaction as the note
-- itself, so an INSERT cannot be refused here without deferring the foreign
-- key. Changing or removing one afterwards can be, and is: the note's own
-- net, tax and gross are immutable above, and so are the stored PDF bytes,
-- so a line that reappeared could not move a single figure of the document.
CREATE OR REPLACE FUNCTION "credit_note_item_is_immutable"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'Die Positionen einer Rechnungskorrektur dürfen nicht geändert werden'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "invoice_immutable" ON "invoice";--> statement-breakpoint
CREATE TRIGGER "invoice_immutable" BEFORE UPDATE ON "invoice"
    FOR EACH ROW EXECUTE FUNCTION "invoice_is_immutable"();--> statement-breakpoint

DROP TRIGGER IF EXISTS "invoice_no_delete" ON "invoice";--> statement-breakpoint
CREATE TRIGGER "invoice_no_delete" BEFORE DELETE ON "invoice"
    FOR EACH ROW EXECUTE FUNCTION "invoice_delete_is_refused"();--> statement-breakpoint

DROP TRIGGER IF EXISTS "invoice_item_immutable" ON "invoice_item";--> statement-breakpoint
CREATE TRIGGER "invoice_item_immutable"
    BEFORE INSERT OR UPDATE OR DELETE ON "invoice_item"
    FOR EACH ROW EXECUTE FUNCTION "invoice_item_follows_invoice"();--> statement-breakpoint

DROP TRIGGER IF EXISTS "credit_note_immutable" ON "credit_note";--> statement-breakpoint
CREATE TRIGGER "credit_note_immutable" BEFORE UPDATE ON "credit_note"
    FOR EACH ROW EXECUTE FUNCTION "credit_note_is_immutable"();--> statement-breakpoint

DROP TRIGGER IF EXISTS "credit_note_no_delete" ON "credit_note";--> statement-breakpoint
CREATE TRIGGER "credit_note_no_delete" BEFORE DELETE ON "credit_note"
    FOR EACH ROW EXECUTE FUNCTION "credit_note_delete_is_refused"();--> statement-breakpoint

DROP TRIGGER IF EXISTS "credit_note_item_immutable" ON "credit_note_item";--> statement-breakpoint
CREATE TRIGGER "credit_note_item_immutable"
    BEFORE UPDATE OR DELETE ON "credit_note_item"
    FOR EACH ROW EXECUTE FUNCTION "credit_note_item_is_immutable"();
