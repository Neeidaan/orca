/**
 * Owner-side progress on one refresh intent. Freshness is proved only by a main-frame cross-document
 * navigation to the resource that started after the request and then committed. Renderer callbacks
 * arrive queued, so "after the request" is proved causally, never by callback time: the navigation
 * follows the owner's own reload/navigate, or its guest was registered after the request.
 */
export type ChangedFileRefreshPhase =
  /** Waiting to look at the guest (not ready yet, or a load just settled). */
  | 'evaluate'
  /** A main-frame load that may predate the request is in flight; act once it commits or fails. */
  | 'settling'
  /** The owner acted, or the guest is newer than the request; waiting for the proving commit. */
  | 'proving'

export type ChangedFileRefreshTracker = {
  seq: number
  /** The guest the phase applies to; events from another guest are stale. */
  generation: number
  phase: ChangedFileRefreshPhase
  /** A main-frame start to the resource that started after the request was seen in this phase. */
  startedResource: boolean
}

export type ChangedFileRefreshGuest = {
  generation: number
  /** Registered after the request, so each of its navigations started after it. */
  createdAfterRequest: boolean
  /** `missing`: destroyed or dead guest; `not-ready`: alive but not yet answering. */
  status: 'missing' | 'not-ready' | 'ready'
  /** The committed main-frame document is the requested resource. */
  showsResource: boolean
  loadingMainFrame: boolean
}

type GuestEvent = { generation: number; createdAfterRequest: boolean }

export type ChangedFileRefreshEvent =
  | { type: 'evaluate'; guest: ChangedFileRefreshGuest }
  /** did-start-navigation with isMainFrame && !isInPlace. */
  | ({ type: 'main-start'; toResource: boolean } & GuestEvent)
  /** did-navigate (main frame only). */
  | ({ type: 'main-commit'; toResource: boolean } & GuestEvent)
  /** Main-frame did-fail-load other than an abort (-3). */
  | ({ type: 'main-fail' } & GuestEvent)
  | { type: 'action-result'; result: 'issued' | 'not-ready' | 'failed' }

export type ChangedFileRefreshAction = 'reload' | 'navigate'

export type ChangedFileRefreshStepResult = {
  /** null: the intent is finished and must be cleared. */
  tracker: ChangedFileRefreshTracker | null
  /** Run through the page's own reload/recovery or navigation path, fenced by seq and generation. */
  action: ChangedFileRefreshAction | null
  outcome: 'satisfied' | 'dropped' | 'failed' | null
  /** Look at the guest again (a pre-request load failed). */
  reevaluate: boolean
}

function result(
  tracker: ChangedFileRefreshTracker | null,
  extra: Partial<Omit<ChangedFileRefreshStepResult, 'tracker'>> = {}
): ChangedFileRefreshStepResult {
  return { tracker, action: null, outcome: null, reevaluate: false, ...extra }
}

function evaluate(seq: number, guest: ChangedFileRefreshGuest): ChangedFileRefreshStepResult {
  const base = { seq, generation: guest.generation, startedResource: false }
  if (guest.status === 'not-ready' || (guest.status === 'missing' && guest.createdAfterRequest)) {
    // A newer-than-request guest still attaching will load on its own; its commit is judged then.
    return result({ ...base, phase: 'evaluate' })
  }
  if (guest.status === 'missing') {
    // The page's reload entry routes a dead guest to recovery rather than a plain reload.
    return result({ ...base, phase: 'proving' }, { action: 'reload' })
  }
  if (guest.showsResource && guest.createdAfterRequest) {
    return result(null, { outcome: 'satisfied' })
  }
  if (guest.loadingMainFrame) {
    return result({ ...base, phase: guest.createdAfterRequest ? 'proving' : 'settling' })
  }
  // Not the resource (doc-preview A navigated to sibling B): go back to A, since reload would refresh B.
  return result(
    { ...base, phase: 'proving' },
    { action: guest.showsResource ? 'reload' : 'navigate' }
  )
}

export function changedFileRefreshStep(
  tracker: ChangedFileRefreshTracker,
  event: ChangedFileRefreshEvent
): ChangedFileRefreshStepResult {
  if (event.type === 'evaluate') {
    return evaluate(tracker.seq, event.guest)
  }
  if (event.type === 'action-result') {
    if (event.result === 'failed') {
      return result(null, { outcome: 'failed' })
    }
    return result(event.result === 'not-ready' ? { ...tracker, phase: 'evaluate' } : tracker)
  }
  if (event.generation !== tracker.generation) {
    // Another guest's event; the owner re-evaluates on its own generation change.
    return result(tracker)
  }
  const { phase } = tracker
  if (event.type === 'main-start') {
    if (!event.toResource) {
      // The user's navigation elsewhere wins; a not-ready guest's restored sibling is judged at commit.
      return phase === 'evaluate' ? result(tracker) : result(null, { outcome: 'dropped' })
    }
    // Otherwise the start may be queued from before the request, so it proves nothing.
    return phase === 'proving' || event.createdAfterRequest
      ? result({ ...tracker, phase: 'proving', startedResource: true })
      : result(tracker)
  }
  if (phase !== 'proving') {
    if (event.type === 'main-fail') {
      return result({ ...tracker, phase: 'evaluate' }, { reevaluate: true })
    }
    // The settled document is the committed one, even while its subresources still load.
    return evaluate(tracker.seq, {
      generation: event.generation,
      createdAfterRequest: event.createdAfterRequest,
      status: 'ready',
      showsResource: event.toResource,
      loadingMainFrame: false
    })
  }
  if (event.type === 'main-fail') {
    // One attempt only; the page's own error or Retry UI shows the failure.
    return result(null, { outcome: 'failed' })
  }
  if (!event.toResource) {
    return result(null, { outcome: 'dropped' })
  }
  return tracker.startedResource || event.createdAfterRequest
    ? result(null, { outcome: 'satisfied' })
    : result(tracker)
}
