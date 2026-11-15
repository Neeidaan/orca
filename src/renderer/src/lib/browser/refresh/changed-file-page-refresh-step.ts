/**
 * Owner-side progress on one refresh intent. Freshness is proved only by a main-frame cross-document
 * navigation to the resource that started after the request and then committed. Renderer callbacks
 * arrive queued, so "after the request" is proved causally, never by callback time: either the guest
 * was registered after the request, or the start arrives after the owner's own action, which the
 * driver issues only once an IPC barrier has drained every guest event main sent before it.
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
  /** The owner already reloaded or navigated this guest for the intent; there is no second try. */
  acted: boolean
  /** The owner already recovered a dead guest for the intent; a second death ends it. */
  recovered: boolean
}

export type ChangedFileRefreshGuest = {
  generation: number
  /** Registered after the request, so each of its navigations started after it. */
  createdAfterRequest: boolean
  /** `missing`: a guest that attached and then died or failed; `not-ready`: alive or still attaching. */
  status: 'missing' | 'not-ready' | 'ready'
  /** The committed main-frame document is the requested resource. */
  showsResource: boolean
  /** The committed main-frame URL, to tell whether another navigation landed in between. */
  committedUrl: string | null
  loadingMainFrame: boolean
}

type GuestEvent = { generation: number; createdAfterRequest: boolean }

export type ChangedFileRefreshEvent =
  | { type: 'evaluate'; guest: ChangedFileRefreshGuest }
  /** The event barrier before an action drained; `before` was read just before it, after the request. */
  | { type: 'barrier-passed'; before: ChangedFileRefreshGuest; after: ChangedFileRefreshGuest }
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

function evaluate(
  tracker: ChangedFileRefreshTracker,
  guest: ChangedFileRefreshGuest
): ChangedFileRefreshStepResult {
  const sameGuest = guest.generation === tracker.generation
  const base = {
    ...tracker,
    generation: guest.generation,
    startedResource: false,
    acted: sameGuest && tracker.acted
  }
  if (guest.status === 'not-ready') {
    // Still attaching or before dom-ready: its first commit or readiness is judged then.
    return result({ ...base, phase: 'evaluate' })
  }
  if (guest.status === 'missing') {
    // One recovery through the page's reload entry; a guest that dies again ends the intent.
    return tracker.recovered
      ? result(null, { outcome: 'failed' })
      : result({ ...base, phase: 'proving', recovered: true }, { action: 'reload' })
  }
  if (guest.showsResource && guest.createdAfterRequest) {
    return result(null, { outcome: 'satisfied' })
  }
  if (guest.loadingMainFrame) {
    return result({ ...base, phase: guest.createdAfterRequest ? 'proving' : 'settling' })
  }
  if (base.acted) {
    // Our action already ran on this guest and it settled without a proving commit.
    return result(null, { outcome: 'failed' })
  }
  // Not the resource (doc-preview A navigated to sibling B): go back to A, since reload would refresh B.
  return result(
    { ...base, phase: 'proving', acted: true },
    { action: guest.showsResource ? 'reload' : 'navigate' }
  )
}

/** Events dropped while the barrier drained may be old, but what the guest shows now is not: a change
 *  since `before` is a navigation the owner did not issue that began after the request, and it wins. */
function afterBarrier(
  tracker: ChangedFileRefreshTracker,
  before: ChangedFileRefreshGuest,
  after: ChangedFileRefreshGuest
): ChangedFileRefreshStepResult {
  const sameReadyGuest =
    before.status === 'ready' && after.status === 'ready' && before.generation === after.generation
  if (!sameReadyGuest) {
    return evaluate(tracker, after)
  }
  if (after.loadingMainFrame && !before.loadingMainFrame) {
    // Its start was dropped while draining but began after the request; its commit decides.
    return result({
      ...tracker,
      generation: after.generation,
      phase: 'proving',
      startedResource: true
    })
  }
  if (after.committedUrl !== before.committedUrl) {
    return after.showsResource
      ? result(null, { outcome: 'satisfied' })
      : result(null, { outcome: 'dropped' })
  }
  return evaluate(tracker, after)
}

export function changedFileRefreshStep(
  tracker: ChangedFileRefreshTracker,
  event: ChangedFileRefreshEvent
): ChangedFileRefreshStepResult {
  if (event.type === 'evaluate') {
    return evaluate(tracker, event.guest)
  }
  if (event.type === 'barrier-passed') {
    return afterBarrier(tracker, event.before, event.after)
  }
  if (event.type === 'action-result') {
    if (event.result === 'failed') {
      return result(null, { outcome: 'failed' })
    }
    // Not ready: the action never ran, so it does not use up the one attempt.
    return result(
      event.result === 'not-ready' ? { ...tracker, phase: 'evaluate', acted: false } : tracker
    )
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
    return evaluate(tracker, {
      generation: event.generation,
      createdAfterRequest: event.createdAfterRequest,
      status: 'ready',
      showsResource: event.toResource,
      committedUrl: null,
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
