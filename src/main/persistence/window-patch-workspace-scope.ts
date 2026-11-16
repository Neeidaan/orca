// Scope a window layout patch to the workspaces it changes, so one tab edit does not clone, load and save the whole fleet's layout.

import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'

type Json = Record<string, unknown>

/** How each stored field is keyed; a new field fails typecheck until it is placed. */
const FIELD_KEYS = {
  activeRepoId: 'whole',
  activeWorkspaceKey: 'whole',
  activeWorkspaceExecutionHostId: 'whole',
  activeWorktreeId: 'whole',
  activeTabId: 'whole',
  tabsByWorktree: 'workspace',
  terminalLayoutsByTabId: 'tab',
  localOnlyScrollbackByTabId: 'tab',
  activeWorktreeIdsOnShutdown: 'whole',
  openFilesByWorktree: 'workspace',
  activeFileIdByWorktree: 'workspace',
  markdownFrontmatterVisible: 'whole',
  browserTabsByWorktree: 'workspace',
  browserPagesByWorkspace: 'tab',
  activeBrowserTabIdByWorktree: 'workspace',
  clientHostedBrowserPagesByWorktree: 'workspace',
  clientHostedBrowserCloseIntentsByEnvironment: 'whole',
  pairedTerminalTabCloseIntentsByEnvironment: 'whole',
  activeTabTypeByWorktree: 'workspace',
  browserUrlHistory: 'whole',
  workspaceDocHistory: 'whole',
  activeTabIdByWorktree: 'workspace',
  unifiedTabs: 'workspace',
  tabGroups: 'workspace',
  tabGroupLayouts: 'workspace',
  activeGroupIdByWorktree: 'workspace',
  activeConnectionIdsAtShutdown: 'whole',
  remoteSessionIdsByTabId: 'whole',
  lastVisitedAtByWorktreeId: 'workspace',
  defaultTerminalTabsAppliedByWorktreeId: 'workspace',
  sleepingAgentSessionsByPaneKey: 'pane',
  terminalPtyIncarnationsByPaneKey: 'pane',
  terminalTopologyRevisionByRepoId: 'whole',
  // Legacy tombstones retire panes across workspaces: their presence takes the full path.
  terminalSurfaceTombstonesByPaneKey: 'pane',
  closedTerminalTabTombstonesByTabId: 'closed-tab',
  closedTerminalPanesByPaneKey: 'pane'
} as const satisfies Record<keyof WorkspaceSessionState, 'whole' | 'workspace' | 'tab' | 'pane' | 'closed-tab'>

type FieldKey = (typeof FIELD_KEYS)[keyof typeof FIELD_KEYS]
const KEYS: Readonly<Record<string, FieldKey>> = FIELD_KEYS

/** Lists the Loader reads one workspace's records from. */
const WORKSPACE_RECORD_LISTS = [
  'tabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  'openFilesByWorktree',
  'browserTabsByWorktree'
] as const

export type WorkspacePatchScope = {
  stored: WorkspaceSessionState
  window: WorkspaceSessionState
  /** The patch's value for `field` as the scoped result would make it, over all workspaces. */
  merge: (field: string, scoped: unknown) => unknown
}

/** Workspace-local ids the Loader resolves across the whole partition. */
type WorkspaceIds = { tabs: Set<string>; leaves: Set<string>; ptys: Set<string>; worktrees: Set<string> }

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asJson(value: unknown): Json {
  return isRecord(value) ? value : {}
}

function asList(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function fieldsOf(session: WorkspaceSessionState): Json {
  return session
}

function field(session: WorkspaceSessionState, name: string): Json {
  return asJson(fieldsOf(session)[name])
}

/** Deep equality where key order and undefined-valued keys do not count. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false
  }
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) =>
    sameJson(left[key], right[key])
  )
}

function paneTabId(paneKey: string): string {
  const split = paneKey.lastIndexOf(':')
  return split === -1 ? paneKey : paneKey.slice(0, split)
}

function collectLeaves(node: unknown, into: Set<string>): void {
  const value = asJson(node)
  if (typeof value.leafId === 'string') {
    into.add(value.leafId)
  }
  if (value.first !== undefined) {
    collectLeaves(value.first, into)
  }
  if (value.second !== undefined) {
    collectLeaves(value.second, into)
  }
}

function workspaceKeys(session: WorkspaceSessionState): Set<string> {
  const keys = new Set<string>()
  for (const name of [...WORKSPACE_RECORD_LISTS, 'tabGroupLayouts']) {
    for (const key of Object.keys(field(session, name))) {
      keys.add(key)
    }
  }
  return keys
}

/** Each workspace's tab, leaf, PTY and worktree ids, read from both partitions. */
function idsByWorkspace(sessions: readonly WorkspaceSessionState[]): Map<string, WorkspaceIds> {
  const result = new Map<string, WorkspaceIds>()
  const idsOf = (key: string): WorkspaceIds => {
    let ids = result.get(key)
    if (!ids) {
      ids = { tabs: new Set(), leaves: new Set(), ptys: new Set(), worktrees: new Set([key]) }
      result.set(key, ids)
    }
    return ids
  }
  for (const session of sessions) {
    for (const name of WORKSPACE_RECORD_LISTS) {
      for (const [key, list] of Object.entries(field(session, name))) {
        const ids = idsOf(key)
        for (const record of asList(list)) {
          for (const id of [record.id, record.entityId]) {
            if (typeof id === 'string') {
              ids.tabs.add(id)
            }
          }
          for (const id of Array.isArray(record.tabOrder) ? record.tabOrder : []) {
            if (typeof id === 'string') {
              ids.tabs.add(id)
            }
          }
          if (typeof record.ptyId === 'string') {
            ids.ptys.add(record.ptyId)
          }
          if (typeof record.worktreeId === 'string') {
            ids.worktrees.add(record.worktreeId)
          }
        }
      }
    }
    for (const key of Object.keys(field(session, 'tabGroupLayouts'))) {
      idsOf(key)
    }
  }
  for (const session of sessions) {
    const layouts = field(session, 'terminalLayoutsByTabId')
    for (const ids of result.values()) {
      for (const tabId of ids.tabs) {
        const layout = asJson(layouts[tabId])
        collectLeaves(layout.root, ids.leaves)
        for (const ptyId of Object.values(asJson(layout.ptyIdsByLeafId))) {
          if (typeof ptyId === 'string') {
            ids.ptys.add(ptyId)
          }
        }
      }
    }
  }
  return result
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true
    }
  }
  return false
}

/** Restrict a session to the touched workspaces' records; fields keyed by nothing stay whole. */
function restrict(
  session: WorkspaceSessionState,
  owns: (key: FieldKey, entryKey: string, entry: unknown) => boolean
): WorkspaceSessionState {
  const scoped: Json = {}
  for (const [name, value] of Object.entries(fieldsOf(session))) {
    const key = KEYS[name] ?? 'whole'
    scoped[name] =
      key === 'whole' || !isRecord(value)
        ? value
        : Object.fromEntries(
            Object.entries(value).filter(([entryKey, entry]) => owns(key, entryKey, entry))
          )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is the session's own value or a subset of its own map.
  return scoped as WorkspaceSessionState
}

/** Null when the patch reaches records the Loader resolves across workspaces: the caller takes the full path. */
export function scopeWindowPatch(
  stored: WorkspaceSessionState,
  window: WorkspaceSessionState,
  patchFields: readonly string[]
): WorkspacePatchScope | null {
  if (
    Object.keys(asJson(stored.terminalSurfaceTombstonesByPaneKey)).length > 0 ||
    Object.keys(asJson(window.terminalSurfaceTombstonesByPaneKey)).length > 0
  ) {
    return null
  }
  const ids = idsByWorkspace([stored, window])
  const tabOwners = new Map<string, string[]>()
  for (const [key, workspace] of ids) {
    for (const tabId of workspace.tabs) {
      tabOwners.set(tabId, [...(tabOwners.get(tabId) ?? []), key])
    }
  }
  const touched = new Set<string>()
  for (const name of patchFields) {
    const key = KEYS[name] ?? 'whole'
    if (key === 'whole') {
      continue
    }
    const before = field(stored, name)
    const after = field(window, name)
    for (const entryKey of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (sameJson(before[entryKey], after[entryKey])) {
        continue
      }
      if (key === 'workspace') {
        touched.add(entryKey)
        continue
      }
      const owners =
        key === 'closed-tab'
          ? [...ids].flatMap(([workspace, { worktrees }]) =>
              [before[entryKey], after[entryKey]].some((record) => worktrees.has(String(asJson(record).worktreeId)))
                ? [workspace]
                : []
            )
          : (tabOwners.get(key === 'pane' ? paneTabId(entryKey) : entryKey) ?? [])
      if (owners.length === 0) {
        return null
      }
      owners.forEach((owner) => touched.add(owner))
    }
  }
  // Joining the window view gives visited empty workspaces owner rows (window-save-view withVisitedRowOwners).
  const present = workspaceKeys(stored)
  for (const key of Object.keys(asJson(window.lastVisitedAtByWorktreeId))) {
    if (present.has(key) && !Object.hasOwn(asJson(stored.tabsByWorktree), key)) {
      touched.add(key)
    }
  }
  const scope: WorkspaceIds = { tabs: new Set(), leaves: new Set(), ptys: new Set(), worktrees: new Set() }
  for (const key of touched) {
    const workspace = ids.get(key)
    workspace?.tabs.forEach((id) => scope.tabs.add(id))
    workspace?.leaves.forEach((id) => scope.leaves.add(id))
    workspace?.ptys.forEach((id) => scope.ptys.add(id))
    workspace?.worktrees.forEach((id) => scope.worktrees.add(id))
  }
  for (const [key, workspace] of ids) {
    if (
      !touched.has(key) &&
      (intersects(workspace.tabs, scope.tabs) ||
        intersects(workspace.leaves, scope.leaves) ||
        intersects(workspace.ptys, scope.ptys) ||
        intersects(workspace.worktrees, scope.worktrees))
    ) {
      return null
    }
  }
  const owns = (key: FieldKey, entryKey: string, entry: unknown): boolean => {
    switch (key) {
      case 'workspace':
        return touched.has(entryKey)
      case 'tab':
        return scope.tabs.has(entryKey)
      case 'pane':
        return scope.tabs.has(paneTabId(entryKey))
      case 'closed-tab':
        return scope.worktrees.has(String(asJson(entry).worktreeId))
      case 'whole':
        return true
    }
  }
  return {
    stored: restrict(stored, owns),
    window: restrict(window, owns),
    merge: (name, scoped) => {
      const key = KEYS[name] ?? 'whole'
      const base = fieldsOf(stored)[name]
      if (key === 'whole' || !isRecord(base) || (scoped !== undefined && !isRecord(scoped))) {
        return scoped
      }
      const result: Json = {}
      const next = asJson(scoped)
      for (const [entryKey, entry] of Object.entries(base)) {
        if (!owns(key, entryKey, entry)) {
          result[entryKey] = entry
        } else if (Object.hasOwn(next, entryKey)) {
          result[entryKey] = next[entryKey]
        }
      }
      for (const [entryKey, entry] of Object.entries(next)) {
        if (!Object.hasOwn(base, entryKey)) {
          result[entryKey] = entry
        }
      }
      // An emptied map is dropped as the full save drops it.
      return scoped === undefined && Object.keys(result).length === 0 ? undefined : result
    }
  }
}
