-- An admin who is also a customer today has to be decided on by a person, not
-- by a migration: the documents name a Kundennummer that has to keep meaning
-- something. Fail loudly and name the accounts rather than quietly unlinking
-- them. Fix by moving those documents to a customer account, or by demoting
-- the account (npm run admin:revoke) before migrating.
DO $$
DECLARE
    conflicting text;
BEGIN
    SELECT string_agg(u.email, ', ') INTO conflicting
    FROM "user" u
    WHERE u.role = 'admin'
      AND (
          EXISTS (SELECT 1 FROM contract c WHERE c.user_id = u.id)
          OR EXISTS (SELECT 1 FROM offer o WHERE o.user_id = u.id)
          OR EXISTS (SELECT 1 FROM invoice i WHERE i.user_id = u.id)
      );

    IF conflicting IS NOT NULL THEN
        RAISE EXCEPTION 'Admin accounts still hold customer documents: %', conflicting
            USING HINT = 'Move the documents to a customer account or demote the account before migrating.';
    END IF;
END $$;--> statement-breakpoint
-- Employees are not customers. Any account that is already an admin gives up
-- its customer number and master data here, so the constraint below can hold
-- from the first moment it exists.
UPDATE "user" SET
    "customer_number" = NULL,
    "company" = NULL,
    "street" = NULL,
    "postal_code" = NULL,
    "city" = NULL,
    "country" = NULL,
    "vat_id" = NULL,
    "phone" = NULL,
    "buyer_reference" = NULL
WHERE "role" = 'admin';--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_admin_has_no_customer_data" CHECK ("user"."role" is distinct from 'admin' or (
            "user"."customer_number" is null
            and "user"."company" is null
            and "user"."street" is null
            and "user"."postal_code" is null
            and "user"."city" is null
            and "user"."country" is null
            and "user"."vat_id" is null
            and "user"."phone" is null
            and "user"."buyer_reference" is null
        ));
