import { afterEach, expect, it, vi } from 'vitest'
import { domainLifecycleFixture } from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import {
  FIRST_SUBMITTED_PROMPT_SCAN_LIMIT,
  FIRST_SUBMITTED_PROMPT_SQL
} from './journal-domain-first-submitted-prompt'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

const body = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

async function send(
  f: ReturnType<typeof domainLifecycleFixture>,
  id: string,
  text: string,
  submittedAt: number
) {
  await f.run({
    kind: 'submission',
    input: { clientMessageId: id, fence: 1, body: body(text), payloadFingerprint: id }
  })
  f.db
    .prepare('UPDATE journal_submission_attempts SET submitted_at=? WHERE message_id=?')
    .run(submittedAt, id)
}

function first(f: ReturnType<typeof domainLifecycleFixture>, sinceMs: number) {
  const result = readJournalSqlPoint(f.db, {
    sessionId: 'chat',
    operation: { kind: 'first-submitted-prompt', sinceMs }
  })
  return result.kind === 'first-submitted-prompt' ? result.first : undefined
}

it('applies the creation bound before taking the earliest submission', async () => {
  const f = domainLifecycleFixture(cleanup)
  await send(f, 'opener', 'Pre-creation opener', 50)
  await send(f, 'qualifying', 'Fix the login form', 110)
  expect(first(f, 100)).toMatchObject({
    kind: 'found',
    prompt: 'Fix the login form',
    submittedAt: 110
  })
})

it('orders by submission time, not journal sequence, and ignores context clears', async () => {
  const f = domainLifecycleFixture(cleanup)
  await send(f, 'sequenced-first', 'Submitted later', 300)
  await send(f, 'sequenced-second', 'Submitted earlier', 200)
  f.db
    .prepare("UPDATE journal_items SET context_clear=1 WHERE item_id LIKE '%sequenced-second%'")
    .run()
  expect(first(f, 100)).toMatchObject({
    kind: 'found',
    prompt: 'Submitted earlier',
    submittedAt: 200
  })
})

it('pages past text-less candidates to the first message with text', async () => {
  const f = domainLifecycleFixture(cleanup)
  for (let index = 0; index < 40; index++) {
    await send(f, `blank-${index}`, '', 200 + index)
  }
  await send(f, 'named', 'Add password reset', 300)
  expect(first(f, 100)).toMatchObject({ kind: 'found', prompt: 'Add password reset' })
})

it('reads past many text-less candidates in one query, not one per page', async () => {
  const f = domainLifecycleFixture(cleanup)
  for (let index = 0; index < 100; index++) {
    await send(f, `blank-${index}`, '', 200 + index)
  }
  await send(f, 'named', 'Add password reset', 400)
  const prepare = vi.spyOn(f.db, 'prepare')
  expect(first(f, 100)).toMatchObject({ kind: 'found', prompt: 'Add password reset' })
  const candidateQueries = prepare.mock.calls.filter(
    ([sql]) => String(sql).includes('journal_item_aliases') && String(sql).includes('submitted_at')
  )
  expect(candidateQueries).toHaveLength(1)
})

it('reports an incomplete scan instead of a miss once the bound is reached', async () => {
  const f = domainLifecycleFixture(cleanup)
  for (let index = 0; index <= FIRST_SUBMITTED_PROMPT_SCAN_LIMIT; index++) {
    await send(f, `blank-${index}`, '', 200 + index)
  }
  expect(first(f, 100)).toEqual({ kind: 'incomplete' })
})

it('matches items and aliases by keyed lookup, never by rescanning item history', () => {
  const f = domainLifecycleFixture(cleanup)
  const plan = f.db
    .prepare(`EXPLAIN QUERY PLAN ${FIRST_SUBMITTED_PROMPT_SQL}`)
    .all('chat', 'e', 0, 'chat', 'e', 'chat', 'e', 'chat', 'e', 'chat', 'e', 1)
    .map((row) => String(row.detail))
  expect(plan.length).toBeGreaterThan(0)
  // Only the session's submissions may be walked; items and aliases must be point lookups.
  expect(plan.filter((detail) => /^SCAN (i|a|o)\b/.test(detail))).toEqual([])
})

it('never treats a message without a submission row as a candidate', async () => {
  const f = domainLifecycleFixture(cleanup)
  await send(f, 'orphaned', 'No submission', 150)
  f.db.prepare("DELETE FROM journal_submission_attempts WHERE message_id='orphaned'").run()
  expect(first(f, 100)).toEqual({ kind: 'none' })
})
