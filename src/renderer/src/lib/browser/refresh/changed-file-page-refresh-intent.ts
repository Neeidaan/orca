import type { BrowserPageDocLocation } from '../../../../../shared/browser-workspace-types'

/** The file a reused page must show fresh: a local page's file URL, or a doc-preview's document. */
export type ChangedFilePageRefreshResource =
  | { kind: 'local-file'; url: string }
  | { kind: 'document'; docLocation: BrowserPageDocLocation }

/** One explicit reopen of a page; a newer request for the page replaces it. */
export type ChangedFilePageRefreshIntent = {
  seq: number
  /** performance.now() at request time, comparable with guest registration times. */
  requestedAt: number
  resource: ChangedFilePageRefreshResource
}
