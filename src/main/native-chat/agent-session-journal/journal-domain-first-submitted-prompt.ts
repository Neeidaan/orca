import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { firstStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-first-prompt'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalFirstSubmittedPrompt =
  | { kind: 'found'; prompt: string; submittedAt: number; sequence: number }
  | { kind: 'none' }
  /** The scan bound was reached before a qualifying message: not proof that none exists. */
  | { kind: 'incomplete' }

export const FIRST_SUBMITTED_PROMPT_SCAN_LIMIT = 512

const USER_ITEM = `i.hidden=0 AND i.root=1 AND i.kind='message' AND i.message_role='user'
  AND i.command_entry=0`

/** One pass over the session's qualifying submissions; every item and alias match is a keyed
 *  lookup (items PK, journal_item_aliases_target), so work grows with submissions, not their product. */
export const FIRST_SUBMITTED_PROMPT_SQL = `WITH sent AS (
  SELECT item_id, submitted_at FROM journal_submission_attempts
  WHERE session_id=? AND epoch=? AND current=1 AND request_failure=0 AND submitted_at>=?
)
SELECT i.payload_json AS payload_json, sent.submitted_at AS submitted_at, i.sequence AS sequence,
  i.sequence_index AS sequence_index, i.ordinal AS ordinal
FROM sent CROSS JOIN journal_items i ON i.session_id=? AND i.epoch=? AND i.item_id=sent.item_id
WHERE ${USER_ITEM} AND NOT EXISTS (SELECT 1 FROM journal_item_aliases o
  WHERE o.session_id=? AND o.epoch=? AND o.provider_item_id=i.item_id)
UNION ALL
SELECT i.payload_json, sent.submitted_at, i.sequence, i.sequence_index, i.ordinal
FROM sent
-- CROSS JOIN pins the order: walk this session's submissions, then keyed alias and item lookups.
CROSS JOIN journal_item_aliases a INDEXED BY journal_item_aliases_target
  ON a.session_id=? AND a.epoch=? AND a.item_id=sent.item_id
CROSS JOIN journal_items i ON i.session_id=? AND i.epoch=? AND i.item_id=a.provider_item_id
WHERE ${USER_ITEM}
ORDER BY submitted_at, sequence, sequence_index, ordinal LIMIT ?`

/** The earliest user message submitted at/after `sinceMs`, by submission time across context clears.
 *  Unlike the naming prompt this ignores the latest-clear floor; items without a submission row never qualify. */
export function readJournalDomainFirstSubmittedPrompt(
  scope: JournalSqlScope,
  sinceMs: number
): JournalFirstSubmittedPrompt {
  const [sessionId, epoch] = scope.prefix
  const rows = scope.db
    .prepare(FIRST_SUBMITTED_PROMPT_SQL)
    .all(
      sessionId,
      epoch,
      sinceMs,
      ...scope.prefix,
      ...scope.prefix,
      ...scope.prefix,
      ...scope.prefix,
      FIRST_SUBMITTED_PROMPT_SCAN_LIMIT + 1
    )
  for (const row of rows.slice(0, FIRST_SUBMITTED_PROMPT_SCAN_LIMIT)) {
    const examined = scope.examined(row)
    const item = scope.decode<AgentJournalRenderItem>(examined.payload_json)
    const prompt = firstStructuredAgentSessionPrompt([item])
    if (prompt) {
      return {
        kind: 'found',
        prompt,
        submittedAt: Number(examined.submitted_at),
        sequence: Number(examined.sequence)
      }
    }
  }
  return rows.length > FIRST_SUBMITTED_PROMPT_SCAN_LIMIT ? { kind: 'incomplete' } : { kind: 'none' }
}
