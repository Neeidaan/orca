export type NativeFirstMessageLookup =
  | { kind: 'found'; prompt: string; submittedAt: number }
  | { kind: 'none' }
  /** Read failed or the feature's read capacity is full: retryable. */
  | { kind: 'unreadable' }

export type NativeFirstMessageReads = {
  listSessionIds: () => Promise<string[]>
  readFirst: (
    sessionId: string,
    sinceMs: number
  ) => Promise<{ prompt: string; submittedAt: number } | null>
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

/** The earliest qualifying native-chat message of the workspace, one point read at a time. */
export async function readNativeFirstMessage(
  reads: NativeFirstMessageReads,
  sinceMs: number
): Promise<NativeFirstMessageLookup> {
  let earliest: { prompt: string; submittedAt: number } | null = null
  for (const sessionId of await reads.listSessionIds()) {
    const first = await reads.readFirst(sessionId, sinceMs)
    if (first && (!earliest || first.submittedAt < earliest.submittedAt)) {
      earliest = first
    }
  }
  return earliest ? { kind: 'found', ...earliest } : { kind: 'none' }
}
