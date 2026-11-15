import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteBrowserPageGuestRegistered,
  observeBrowserPageMainFrameEvents
} from '@/components/browser-pane/host-guest/lifecycle/browser-page-main-frame-events'
import { createChangedFilePageRefreshActions } from '@/store/slices/browser/pages/changed-file-page-refresh-actions'
import {
  driveChangedFilePageRefresh,
  sameDocumentUrl,
  type ChangedFileRefreshActionResult
} from './changed-file-page-refresh-driver'
import type { BrowserSlice } from '@/store/slices/browser/browser-slice-contract'
import type { ChangedFilePageRefreshResource } from './changed-file-page-refresh-intent'

type RefreshStore = Pick<
  BrowserSlice,
  'changedFileRefreshByPageId' | 'requestChangedFilePageRefresh' | 'settleChangedFilePageRefresh'
>
const store: { state: RefreshStore | null } = vi.hoisted(() => ({ state: null }))

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store.state } }))

const PAGE = 'page-1'
const FILE_URL = 'file:///repo/site/index.html'
const resource: ChangedFilePageRefreshResource = { kind: 'local-file', url: FILE_URL }

class FakeGuest extends EventTarget {
  url = FILE_URL
  loading = false
  alive = true
  crashed = false
  isCrashed(): boolean {
    return this.crashed
  }
  getWebContentsId(): number {
    if (!this.alive) {
      throw new Error('guest destroyed')
    }
    return 1
  }
  getURL(): string {
    return this.url
  }
  isLoadingMainFrame(): boolean {
    return this.loading
  }
  fire(type: string, detail: Record<string, unknown> = {}): void {
    this.dispatchEvent(Object.assign(new Event(type), detail))
  }
  start(url: string, detail: Record<string, unknown> = {}): void {
    this.fire('did-start-navigation', { url, isMainFrame: true, isInPlace: false, ...detail })
  }
  commit(url: string): void {
    this.url = url
    this.fire('did-navigate', { url })
  }
}

function setUpStore(): RefreshStore {
  const state: RefreshStore = {
    changedFileRefreshByPageId: {},
    ...createChangedFilePageRefreshActions((update) => {
      Object.assign(state, update(state))
    })
  }
  store.state = state
  return state
}

/** The fake implements only what the driver and event seam call on a guest. */
function asWebview(guest: FakeGuest): Electron.WebviewTag {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the driver reads getWebContentsId/getURL/isLoadingMainFrame and DOM events only.
  return guest as unknown as Electron.WebviewTag
}

function newGuest(initial: Partial<Pick<FakeGuest, 'url' | 'loading' | 'alive'>> = {}): FakeGuest {
  const guest = Object.assign(new FakeGuest(), initial)
  noteBrowserPageGuestRegistered(asWebview(guest))
  observeBrowserPageMainFrameEvents(PAGE, asWebview(guest))
  return guest
}

/** The IPC barrier, released by the test: events fired before release play queued deliveries. */
function deferredBarrier(): { barrier: () => Promise<unknown>; release: () => Promise<void> } {
  let resolvers: (() => void)[] = []
  return {
    barrier: () => new Promise<void>((resolve) => resolvers.push(resolve)),
    release: async () => {
      const pendingResolvers = resolvers
      resolvers = []
      for (const resolve of pendingResolvers) {
        resolve()
      }
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

function drive(guest: () => FakeGuest | null, options: { guestFailed?: () => boolean } = {}) {
  const reload = vi.fn((): ChangedFileRefreshActionResult => 'issued')
  const navigate = vi.fn((): ChangedFileRefreshActionResult => 'issued')
  const gate = deferredBarrier()
  const handle = driveChangedFilePageRefresh(
    PAGE,
    store.state!.changedFileRefreshByPageId[PAGE]!,
    {
      readWebview: () => {
        const current = guest()
        return current ? asWebview(current) : null
      },
      pointsAtResource: () => true,
      isResourceUrl: (url) => sameDocumentUrl(url, FILE_URL),
      ...(options.guestFailed ? { guestFailed: options.guestFailed } : {}),
      reload,
      navigate
    },
    gate.barrier
  )
  return { reload, navigate, release: gate.release, ...handle }
}

function pending(): boolean {
  return Boolean(store.state?.changedFileRefreshByPageId[PAGE])
}

describe('changed-file page refresh driver', () => {
  let state: RefreshStore
  beforeEach(() => {
    state = setUpStore()
  })

  it('reloads the existing guest once, after the event barrier, and clears on its start and commit', async () => {
    const guest = newGuest()
    state.requestChangedFilePageRefresh(PAGE, resource)
    const { reload, release } = drive(() => guest)
    expect(reload).not.toHaveBeenCalled()
    await release()
    expect(reload).toHaveBeenCalledTimes(1)
    guest.start(FILE_URL)
    guest.commit(`${FILE_URL}#top`)
    expect(pending()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('is not satisfied by a pre-request navigation whose start and commit arrive queued', async () => {
    const guest = newGuest()
    state.requestChangedFilePageRefresh(PAGE, resource)
    const { reload, release } = drive(() => guest)
    // An old load of the file finished in the guest before the click; its callbacks land now.
    guest.start(FILE_URL)
    guest.commit(FILE_URL)
    expect(pending()).toBe(true)
    await release()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(pending()).toBe(true)
    guest.start(FILE_URL)
    guest.commit(FILE_URL)
    expect(pending()).toBe(false)
  })

  it('is not satisfied by iframe loading, subframe navigation or in-page navigation', async () => {
    const guest = newGuest()
    state.requestChangedFilePageRefresh(PAGE, resource)
    const { release } = drive(() => guest)
    await release()
    guest.fire('did-start-loading')
    guest.fire('did-stop-loading')
    guest.start('file:///repo/site/frame.html', { isMainFrame: false })
    guest.start(`${FILE_URL}#section`, { isInPlace: true })
    guest.fire('did-navigate-in-page', { url: `${FILE_URL}#section`, isMainFrame: true })
    guest.fire('did-fail-load', { isMainFrame: false, errorCode: -105 })
    expect(pending()).toBe(true)
  })

  it('lets a newer request replace an older one, and a stale settle cannot clear it', () => {
    state.requestChangedFilePageRefresh(PAGE, resource)
    const older = state.changedFileRefreshByPageId[PAGE]!.seq
    state.requestChangedFilePageRefresh(PAGE, resource)
    const newer = state.changedFileRefreshByPageId[PAGE]!.seq
    expect(newer).toBeGreaterThan(older)
    state.settleChangedFilePageRefresh(PAGE, older)
    expect(state.changedFileRefreshByPageId[PAGE]?.seq).toBe(newer)
  })

  it('does not act for a request superseded while its barrier drains', async () => {
    const guest = newGuest()
    state.requestChangedFilePageRefresh(PAGE, resource)
    const { reload, release } = drive(() => guest)
    state.requestChangedFilePageRefresh(PAGE, resource)
    await release()
    guest.start(FILE_URL)
    guest.commit(FILE_URL)
    expect(reload).not.toHaveBeenCalled()
    expect(pending()).toBe(true)
  })

  it('judges a replacement guest instead of acting on it with a stale decision', async () => {
    let current: FakeGuest | null = newGuest()
    current.getWebContentsId()
    state.requestChangedFilePageRefresh(PAGE, resource)
    current.crashed = true
    const { reload, release } = drive(() => current)
    await release()
    expect(reload).toHaveBeenCalledTimes(1)
    // Recovery replaced the guest after the request; its own first load proves freshness.
    current = newGuest({ url: '', loading: true })
    expect(pending()).toBe(true)
    current.start(FILE_URL)
    current.commit(FILE_URL)
    expect(pending()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('waits for an attaching replacement, recovers it once if it dies, and fails on a second death', async () => {
    state.requestChangedFilePageRefresh(PAGE, resource)
    let current = newGuest({ alive: false })
    const { reload, release } = drive(() => current)
    await release()
    expect(reload).not.toHaveBeenCalled()
    current.fire('render-process-gone')
    await release()
    expect(reload).toHaveBeenCalledTimes(1)
    current = newGuest({ alive: false })
    current.fire('destroyed')
    await release()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(pending()).toBe(false)
  })

  it('recovers a preview that failed without any guest, once', async () => {
    let failed = false
    state.requestChangedFilePageRefresh(PAGE, resource)
    const { reload, release, reevaluate } = drive(() => null, { guestFailed: () => failed })
    failed = true
    reevaluate()
    await release()
    expect(reload).toHaveBeenCalledTimes(1)
    reevaluate()
    await release()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(pending()).toBe(false)
  })
})
