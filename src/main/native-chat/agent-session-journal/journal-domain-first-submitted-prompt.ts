import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { firstStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-first-prompt'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalFirstSubmittedPrompt =
  | { kind: 'found'; prompt: string; submittedAt: number; sequence: number }
  | { kind: 'none' }
  /** The scan bound was reached before a qualifying message: not proof that none exists. */
  | { kind: 'incomplete' }

const CANDIDATE_PAGE = 32
export const FIRST_SUBMITTED_PROMPT_SCAN_LIMIT = 512

type Cursor = [submittedAt: number, sequence: number, sequenceIndex: number, ordinal: number]

/** The earliest user message submitted at/after `sinceMs`, by submission time across context clears.
 *  Unlike the naming prompt this ignores the latest-clear floor; items without a submission row never qualify.
 *  Keyset pages keep a long run of text-less candidates linear, and the scan is bounded. */
export function readJournalDomainFirstSubmittedPrompt(
  scope: JournalSqlScope,
  sinceMs: number
): JournalFirstSubmittedPrompt {
  let after: Cursor = [sinceMs, -1, -1, -1]
  for (let scanned = 0; scanned < FIRST_SUBMITTED_PROMPT_SCAN_LIMIT;) {
    const rows = scope.db
      .prepare(`SELECT i.payload_json AS payload_json, s.submitted_at AS submitted_at,
        i.sequence AS sequence, i.sequence_index AS sequence_index, i.ordinal AS ordinal
      FROM journal_items i
      JOIN journal_submission_attempts s
        ON s.session_id=i.session_id AND s.epoch=i.epoch AND s.current=1
        AND s.request_failure=0 AND s.submitted_at>=?
        AND s.item_id=COALESCE((SELECT a.item_id FROM journal_item_aliases a
          WHERE a.session_id=i.session_id AND a.epoch=i.epoch AND a.provider_item_id=i.item_id),
          i.item_id)
      WHERE i.session_id=? AND i.epoch=? AND i.hidden=0 AND i.root=1 AND i.kind='message'
        AND i.message_role='user' AND i.command_entry=0
        AND (s.submitted_at, i.sequence, i.sequence_index, i.ordinal) > (?, ?, ?, ?)
      ORDER BY s.submitted_at, i.sequence, i.sequence_index, i.ordinal LIMIT ?`)
      .all(sinceMs, ...scope.prefix, ...after, CANDIDATE_PAGE)
    for (const row of rows) {
      const examined = scope.examined(row)
      scanned++
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
      after = [
        Number(examined.submitted_at),
        Number(examined.sequence),
        Number(examined.sequence_index),
        Number(examined.ordinal)
      ]
    }
    if (rows.length < CANDIDATE_PAGE) {
      return { kind: 'none' }
    }
  }
  return { kind: 'incomplete' }
}
