import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("billing_spend_calls").addColumn("price_snapshot", "jsonb").execute();
  await db.schema
    .alterTable("billing_adjustments")
    .addColumn("source_period", "date")
    .addColumn("source_statement_line_id", "uuid")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("billing_adjustments")
    .dropColumn("source_statement_line_id")
    .dropColumn("source_period")
    .execute();
  await db.schema.alterTable("billing_spend_calls").dropColumn("price_snapshot").execute();
}
