import { sql } from "kysely";
import type { Db } from "../../db/client.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function period(month: string): Date {
  if (!MONTH.test(month)) throw new BillingStatementError(400, "Month must be YYYY-MM.");
  return new Date(`${month}-01T00:00:00.000Z`);
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function nextMonth(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

export class BillingStatementError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "BillingStatementError";
  }
}

export interface BillingStatementLine {
  id: string;
  teamId: string | null;
  teamName: string;
  repositoryId: number;
  repositoryName: string;
  model: string;
  lineType: "usage" | "adjustment";
  description: string | null;
  calls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: string | null;
}

export interface BillingStatement {
  month: string;
  closedAt: string | null;
  closedBy: string | null;
  lines: BillingStatementLine[];
}

type RawLine = {
  id: string;
  team_id: string | null;
  team_name: string;
  repository_id: string | number;
  repository_name: string;
  model: string;
  line_type: "usage" | "adjustment";
  description: string | null;
  calls: string | number;
  unpriced_calls: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  cost_usd: string | null;
};

function line(row: RawLine): BillingStatementLine {
  return {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name,
    repositoryId: Number(row.repository_id),
    repositoryName: row.repository_name,
    model: row.model,
    lineType: row.line_type,
    description: row.description,
    calls: Number(row.calls),
    unpricedCalls: Number(row.unpriced_calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    costUsd: row.cost_usd,
  };
}

export async function getBillingStatement(db: Db, month: string): Promise<BillingStatement> {
  const start = period(month);
  const closed = await db
    .selectFrom("billing_periods")
    .select(["closed_at", "closed_by"])
    .where("period_start", "=", `${month}-01`)
    .executeTakeFirst();
  if (closed) {
    const saved = await sql<RawLine>`
      select id::text, team_id::text, team_name, repository_id::text, repository_name, model,
             line_type, description, calls::text, unpriced_calls::text, input_tokens::text,
             output_tokens::text, cache_read_tokens::text, cache_write_tokens::text, cost_usd::text
        from billing_statement_lines
       where period_start = ${start}
       order by team_name, repository_name, model, line_type, id`.execute(db);
    return {
      month,
      closedAt: closed.closed_at.toISOString(),
      closedBy: closed.closed_by,
      lines: saved.rows.map(line),
    };
  }

  const end = nextMonth(start);
  const spend = await sql<RawLine>`
    select concat(coalesce(a.team_id::text, 'unattributed'), ':', c.repository_id, ':', c.model) as id,
           a.team_id::text, a.team_name, c.repository_id::text, c.repository_name, c.model,
           'usage'::text as line_type, null::text as description,
           count(*)::text as calls,
           count(*) filter (where c.cost_usd is null)::text as unpriced_calls,
           sum(a.input_tokens)::text as input_tokens, sum(a.output_tokens)::text as output_tokens,
           sum(a.cache_read_tokens)::text as cache_read_tokens,
           sum(a.cache_write_tokens)::text as cache_write_tokens,
           sum(a.cost_usd)::text as cost_usd
      from billing_spend_allocations a
      join billing_spend_calls c on c.id = a.spend_call_id
     where c.spent_at >= ${start} and c.spent_at < ${end}
     group by a.team_id, a.team_name, c.repository_id, c.repository_name, c.model
     order by a.team_name, c.repository_name, c.model`.execute(db);
  const adjustments = await sql<RawLine>`
    select id::text, team_id::text, team_name, repository_id::text, repository_name, model,
           'adjustment'::text as line_type, reason as description,
           1::text as calls, (cost_usd is null)::int::text as unpriced_calls,
           input_tokens::text, output_tokens::text, cache_read_tokens::text,
           cache_write_tokens::text, cost_usd::text
      from billing_adjustments
     where period_start = ${start}
     order by team_name, repository_name, id`.execute(db);
  return {
    month,
    closedAt: null,
    closedBy: null,
    lines: [...spend.rows.map(line), ...adjustments.rows.map(line)],
  };
}

async function closePeriod(
  db: Db,
  start: Date,
  now: Date,
): Promise<{ closed: boolean; unpricedCalls: number }> {
  const month = monthOf(start);
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('graft-billing'), hashtext(${month}))`.execute(
      tx,
    );
    const existing = await tx
      .selectFrom("billing_periods")
      .select("period_start")
      .where("period_start", "=", `${month}-01`)
      .executeTakeFirst();
    if (existing) return { closed: true, unpricedCalls: 0 };

    const end = nextMonth(start);
    const unpriced = await sql<{ n: string }>`
      select (
        (select count(*) from billing_spend_calls
          where spent_at >= ${start} and spent_at < ${end} and cost_usd is null)
        +
        (select count(*) from billing_adjustments
          where period_start = ${start} and cost_usd is null)
      )::text as n`.execute(tx);
    const unpricedCalls = Number(unpriced.rows[0]?.n ?? 0);
    if (unpricedCalls > 0) return { closed: false, unpricedCalls };

    const hasSpend = await sql<{ n: string }>`
      select (
        (select count(*) from billing_spend_calls where spent_at >= ${start} and spent_at < ${end})
        +
        (select count(*) from billing_adjustments where period_start = ${start})
      )::text as n`.execute(tx);
    if (Number(hasSpend.rows[0]?.n ?? 0) === 0) return { closed: false, unpricedCalls: 0 };

    await tx
      .insertInto("billing_periods")
      .values({ period_start: `${month}-01`, closed_at: now, closed_by: "system" })
      .execute();
    await sql`
      insert into billing_statement_lines
        (period_start, team_id, team_name, repository_id, repository_name, model, line_type,
         description, calls, unpriced_calls, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cost_usd)
      select ${start}, a.team_id, a.team_name, c.repository_id, c.repository_name, c.model,
             'usage', null, count(*), 0, sum(a.input_tokens), sum(a.output_tokens),
             sum(a.cache_read_tokens), sum(a.cache_write_tokens), sum(a.cost_usd)
        from billing_spend_allocations a
        join billing_spend_calls c on c.id = a.spend_call_id
       where c.spent_at >= ${start} and c.spent_at < ${end}
       group by a.team_id, a.team_name, c.repository_id, c.repository_name, c.model`.execute(tx);
    await sql`
      insert into billing_statement_lines
        (period_start, team_id, team_name, repository_id, repository_name, model, line_type,
         description, adjustment_id, calls, unpriced_calls, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd)
      select period_start, team_id, team_name, repository_id, repository_name, model,
             'adjustment', reason, id, 1, 0, input_tokens, output_tokens, cache_read_tokens,
             cache_write_tokens, cost_usd
        from billing_adjustments where period_start = ${start}`.execute(tx);
    return { closed: true, unpricedCalls: 0 };
  });
}

export async function closeEligibleBillingPeriods(
  db: Db,
  now: Date,
): Promise<{ closed: string[]; blocked: { month: string; unpricedCalls: number }[] }> {
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const candidates = await sql<{ period_start: string }>`
    select distinct period_start::text from (
      select date_trunc('month', spent_at at time zone 'UTC')::date as period_start
        from billing_spend_calls where spent_at < ${currentMonth}
      union
      select period_start from billing_adjustments where period_start < ${currentMonth}
    ) periods order by period_start`.execute(db);
  const closed: string[] = [];
  const blocked: { month: string; unpricedCalls: number }[] = [];
  for (const candidate of candidates.rows) {
    const start = period(`${candidate.period_start.slice(0, 7)}`);
    const result = await closePeriod(db, start, now);
    const month = monthOf(start);
    if (result.closed) closed.push(month);
    else if (result.unpricedCalls > 0) blocked.push({ month, unpricedCalls: result.unpricedCalls });
  }
  return { closed, blocked };
}

export async function createBillingAdjustment(
  db: Db,
  o: {
    sourcePeriod: string;
    sourceLineId: string;
    amountUsd: string;
    reason: string;
    actor: string;
    now: Date;
  },
): Promise<{ period: string }> {
  const sourceStart = period(o.sourcePeriod);
  if (!/^-?\d{1,12}(?:\.\d{1,2})?$/.test(o.amountUsd) || Number(o.amountUsd) === 0) {
    throw new BillingStatementError(
      400,
      "Adjustment amount must be a non-zero USD amount to cents.",
    );
  }
  const reason = o.reason.trim();
  if (!reason || reason.length > 500) {
    throw new BillingStatementError(400, "Adjustment reason must be 1–500 characters.");
  }
  const next = nextMonth(sourceStart);
  return db.transaction().execute(async (tx) => {
    const source = await tx
      .selectFrom("billing_statement_lines")
      .selectAll()
      .where("id", "=", o.sourceLineId)
      .where("period_start", "=", `${o.sourcePeriod}-01`)
      .executeTakeFirst();
    if (!source) throw new BillingStatementError(404, "Closed statement line not found.");
    if (source.line_type !== "usage")
      throw new BillingStatementError(400, "Adjustments must reference a usage line.");
    await sql`select pg_advisory_xact_lock(hashtext('graft-billing'), hashtext(${monthOf(next)}))`.execute(
      tx,
    );
    let target = next;
    for (let i = 0; i < 120; i++) {
      const closed = await tx
        .selectFrom("billing_periods")
        .select("period_start")
        .where("period_start", "=", `${monthOf(target)}-01`)
        .executeTakeFirst();
      if (!closed) break;
      target = nextMonth(target);
      if (i === 119) throw new BillingStatementError(409, "No open billing month is available.");
    }
    await tx
      .insertInto("billing_adjustments")
      .values({
        period_start: `${monthOf(target)}-01`,
        team_id: source.team_id,
        team_name: source.team_name,
        repository_id: source.repository_id,
        repository_name: source.repository_name,
        model: source.model,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: o.amountUsd,
        source_call_id: null,
        reason,
        created_by: o.actor,
        created_at: o.now,
      })
      .execute();
    return { period: monthOf(target) };
  });
}

export function billingMonthStart(month: string): Date {
  return period(month);
}

export function nextBillingMonth(month: string): string {
  return monthOf(nextMonth(period(month)));
}
