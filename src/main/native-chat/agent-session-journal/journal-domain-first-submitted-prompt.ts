import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { firstStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-first-prompt'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalFirstSubmittedPrompt = { prompt: string; submittedAt: number } | null

const CANDIDATE_PAGE = 32

/** The earliest user message submitted at/after `sinceMs`, by submission time across context clears.
 *  Unlike the naming prompt this ignores the latest-clear floor; items without a submission row never qualify. */
export function readJournalDomainFirstSubmittedPrompt(
  scope: JournalSqlScope,
  sinceMs: number
): JournalFirstSubmittedPrompt {
  let offset = 0
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT i.payload_json AS payload_json, s.submitted_at AS submitted_at
      FROM journal_items i
      JOIN journal_submission_attempts s
        ON s.session_id=i.session_id AND s.epoch=i.epoch AND s.current=1
        AND s.request_failure=0 AND s.submitted_at>=?
        AND s.item_id=COALESCE((SELECT a.item_id FROM journal_item_aliases a
          WHERE a.session_id=i.session_id AND a.epoch=i.epoch AND a.provider_item_id=i.item_id),
          i.item_id)
      WHERE i.session_id=? AND i.epoch=? AND i.hidden=0 AND i.root=1 AND i.kind='message'
        AND i.message_role='user' AND i.command_entry=0
      ORDER BY s.submitted_at, i.sequence, i.sequence_index, i.ordinal LIMIT ? OFFSET ?`)
      .all(sinceMs, ...scope.prefix, CANDIDATE_PAGE, offset)
    for (const row of rows) {
      const examined = scope.examined(row)
      const item = scope.decode<AgentJournalRenderItem>(examined.payload_json)
      const prompt = firstStructuredAgentSessionPrompt([item])
      if (prompt) {
        return { prompt, submittedAt: Number(examined.submitted_at) }
      }
    }
    if (rows.length < CANDIDATE_PAGE) {
      return null
    }
    offset += CANDIDATE_PAGE
  }
}
