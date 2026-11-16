import type { JournalFirstSubmittedPrompt } from '../../native-chat/agent-session-journal/journal-domain-first-submitted-prompt'

export type NativeFirstMessageLookup =
  | { kind: 'found'; prompt: string; submittedAt: number }
  | { kind: 'none' }
  /** Read failed, a scan was incomplete, or the feature's read capacity is full: retryable. */
  | { kind: 'unreadable' }

export type NativeFirstMessageReads = {
  listSessionIds: () => Promise<string[]>
  readFirst: (sessionId: string, sinceMs: number) => Promise<JournalFirstSubmittedPrompt>
}

// Leases outlive a logical timeout until the physical read settles, so expiries cannot pile up reads.
const physicalReads = new Map<string, Promise<NativeFirstMessageLookup>>()
export const MAX_NATIVE_FIRST_MESSAGE_READS = 2

export function resetNativeFirstMessageReads(): void {
  physicalReads.clear()
}

/** Joins a draining read for the same incarnation before applying feature-wide capacity. */
export function leaseNativeFirstMessageRead(
  incarnation: string,
  read: () => Promise<NativeFirstMessageLookup>
): Promise<NativeFirstMessageLookup> {
  const draining = physicalReads.get(incarnation)
  if (draining) {
    return draining
  }
  if (physicalReads.size >= MAX_NATIVE_FIRST_MESSAGE_READS) {
    return Promise.resolve({ kind: 'unreadable' })
  }
  const physical = read().catch((): NativeFirstMessageLookup => ({ kind: 'unreadable' }))
  physicalReads.set(incarnation, physical)
  void physical.finally(() => {
    if (physicalReads.get(incarnation) === physical) {
      physicalReads.delete(incarnation)
    }
  })
  return physical
}

type Candidate = { prompt: string; submittedAt: number; sequence: number; sessionId: string }

/** D4 order: submission time, then item sequence; session id only makes an exact tie deterministic. */
function precedes(left: Candidate, right: Candidate): boolean {
  if (left.submittedAt !== right.submittedAt) {
    return left.submittedAt < right.submittedAt
  }
  if (left.sequence !== right.sequence) {
    return left.sequence < right.sequence
  }
  return left.sessionId < right.sessionId
}

/** The earliest qualifying native-chat message of the workspace, one point read at a time. */
export async function readNativeFirstMessage(
  reads: NativeFirstMessageReads,
  sinceMs: number
): Promise<NativeFirstMessageLookup> {
  let earliest: Candidate | null = null
  for (const sessionId of await reads.listSessionIds()) {
    const first = await reads.readFirst(sessionId, sinceMs)
    if (first.kind === 'incomplete') {
      return { kind: 'unreadable' }
    }
    if (first.kind === 'found') {
      const candidate = { ...first, sessionId }
      if (!earliest || precedes(candidate, earliest)) {
        earliest = candidate
      }
    }
  }
  return earliest
    ? { kind: 'found', prompt: earliest.prompt, submittedAt: earliest.submittedAt }
    : { kind: 'none' }
}
