/** Main-frame document lifecycle only: iframe loads and in-page navigations never appear here. */
export type BrowserPageMainFrameEvent =
  | { type: 'start'; url: string }
  | { type: 'commit'; url: string }
  | { type: 'fail' }
  | { type: 'ready' }
  /** The page's owner bound this guest element; it may be a new generation. */
  | { type: 'attached' }

export type BrowserPageGuestIdentity = {
  /** Increases for every guest element a page gets (remount, remint, recovery). */
  generation: number
  /** performance.now() when the element was registered, before its guest could navigate. */
  registeredAt: number
}

type Listener = (webview: Electron.WebviewTag, event: BrowserPageMainFrameEvent) => void

const listenersByPageId = new Map<string, Set<Listener>>()
const guestIdentities = new WeakMap<Electron.WebviewTag, BrowserPageGuestIdentity>()
let nextGeneration = 1

export function noteBrowserPageGuestRegistered(webview: Electron.WebviewTag): void {
  if (!guestIdentities.has(webview)) {
    guestIdentities.set(webview, { generation: nextGeneration++, registeredAt: performance.now() })
  }
}

export function browserPageGuestIdentity(
  webview: Electron.WebviewTag
): BrowserPageGuestIdentity | null {
  return guestIdentities.get(webview) ?? null
}

export function subscribeBrowserPageMainFrameEvents(
  pageId: string,
  listener: Listener
): () => void {
  let listeners = listenersByPageId.get(pageId)
  if (!listeners) {
    listeners = new Set()
    listenersByPageId.set(pageId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && listenersByPageId.get(pageId) === listeners) {
      listenersByPageId.delete(pageId)
    }
  }
}

function emit(
  pageId: string,
  webview: Electron.WebviewTag,
  event: BrowserPageMainFrameEvent
): void {
  const listeners = listenersByPageId.get(pageId)
  if (listeners) {
    // oxlint-disable-next-line unicorn/no-useless-spread -- A listener may unsubscribe while handling.
    for (const listener of [...listeners]) {
      listener(webview, event)
    }
  }
}

/** Publishes the page guest's main-frame document starts, commits and failures; returns the unbind. */
export function observeBrowserPageMainFrameEvents(
  pageId: string,
  webview: Electron.WebviewTag
): () => void {
  const onStart = (event: Electron.DidStartNavigationEvent): void => {
    // Same filter as the page's navigation handlers; did-start-loading would include iframes.
    if (event.isMainFrame && !event.isInPlace && event.url) {
      emit(pageId, webview, { type: 'start', url: event.url })
    }
  }
  // Electron's did-navigate is main-frame only; in-page navigations use did-navigate-in-page.
  const onCommit = (event: Electron.DidNavigateEvent): void => {
    emit(pageId, webview, { type: 'commit', url: event.url })
  }
  const onFail = (event: Electron.DidFailLoadEvent): void => {
    // -3 is an abort: a newer navigation replaced this one, which reports its own outcome.
    if (event.isMainFrame && event.errorCode !== -3) {
      emit(pageId, webview, { type: 'fail' })
    }
  }
  const onReady = (): void => emit(pageId, webview, { type: 'ready' })
  webview.addEventListener('did-start-navigation', onStart)
  webview.addEventListener('did-navigate', onCommit)
  webview.addEventListener('did-fail-load', onFail)
  webview.addEventListener('dom-ready', onReady)
  emit(pageId, webview, { type: 'attached' })
  return () => {
    webview.removeEventListener('did-start-navigation', onStart)
    webview.removeEventListener('did-navigate', onCommit)
    webview.removeEventListener('did-fail-load', onFail)
    webview.removeEventListener('dom-ready', onReady)
  }
}
