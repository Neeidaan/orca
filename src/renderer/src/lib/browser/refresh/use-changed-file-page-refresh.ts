import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import {
  driveChangedFilePageRefresh,
  type ChangedFilePageRefreshOwner
} from './changed-file-page-refresh-driver'

/** Lets the component that owns a page's guest satisfy that page's explicit-reopen refresh intent. */
export function useChangedFilePageRefresh(
  /** null for a page this component does not own a guest for. */
  pageId: string | null,
  owner: ChangedFilePageRefreshOwner
): void {
  const intent = useAppStore((s) =>
    pageId ? (s.changedFileRefreshByPageId[pageId] ?? null) : null
  )
  const ownerRef = useRef(owner)
  useEffect(() => {
    ownerRef.current = owner
  })
  useEffect(() => {
    if (!intent || !pageId) {
      return
    }
    // Delegate so every step reads the owner's latest page state and guest.
    const latest = ownerRef
    return driveChangedFilePageRefresh(pageId, intent, {
      readWebview: () => latest.current.readWebview(),
      pointsAtResource: (resource) => latest.current.pointsAtResource(resource),
      isResourceUrl: (url, resource) => latest.current.isResourceUrl(url, resource),
      guestFailed: () => latest.current.guestFailed?.() ?? false,
      reload: () => latest.current.reload(),
      navigate: (resource) => latest.current.navigate(resource)
    })
  }, [intent, pageId])
}
