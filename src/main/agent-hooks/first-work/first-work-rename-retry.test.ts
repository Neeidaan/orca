import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/worktree/id'

const { gitExecFileAsyncMock, generateBranchNameMock, resolveParamsMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  generateBranchNameMock: vi.fn(),
  resolveParamsMock: vi.fn()
}))

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../../git/repositories/git-username', () => ({
  resolveLocalGitUsername: async () => null
}))
vi.mock('../../text-generation/commit-message-text-generation', () => ({
  generateBranchNameFromContext: generateBranchNameMock,
  resolveCommitMessageSettings: resolveParamsMock
}))
vi.mock('./first-work-generation-target', () => ({
  resolveGenerationTarget: async () => ({ kind: 'local' })
}))
vi.mock('../../ipc/worktree-branch-name', () => ({
  computeBranchName: (leaf: string) => leaf,
  getConfiguredBranchPrefix: () => null
}))

import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from './first-work-branch-rename'
import {
  FIRST_WORK_RETRY_LOOKUP_DEADLINE_MS,
  retryFirstWorkRename,
  type FirstWorkRetryDeps
} from './first-work-rename-retry'
import { resetNativeFirstMessageReads } from './first-work-native-first-message'
import {
  WORKTREE_ID,
  gitResponder,
  makeBranchRenameDeps,
  workingEvent
} from './testing/first-work-branch-rename-test-harness'

type Reads = FirstWorkRetryDeps['nativeReads']

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const noNativeChat: Reads = () => ({ listSessionIds: async () => [], readFirst: async () => null })

function changesGit(stat: string) {
  return async (args: string[]) => {
    if (args[0] === 'rev-parse') {
      return { stdout: 'base-sha\n' }
    }
    if (args[0] === 'merge-base') {
      return { stdout: 'merge-sha\n' }
    }
    return { stdout: args[0] === 'diff' && !args.includes('--cached') ? stat : '' }
  }
}

function makeRetryDeps(overrides: Partial<FirstWorkRetryDeps> = {}) {
  const base = makeBranchRenameDeps(vi.fn)
  const deps: FirstWorkRetryDeps = {
    ...base.deps,
    getWorkspaceCreatedAt: () => 100,
    getBaseRef: () => 'origin/main',
    nativeReads: noNativeChat,
    runGit: changesGit(''),
    ...overrides
  }
  return { ...base, deps }
}

beforeEach(() => {
  resetFirstWorkBranchRenameState()
  resetNativeFirstMessageReads()
  generateBranchNameMock.mockReset()
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(
    gitResponder({ currentBranch: 'Nautilus-8', hasUpstream: false })
  )
  resolveParamsMock.mockReturnValue({ ok: true, params: { agentId: 'claude' } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('retryFirstWorkRename', () => {
  it('names the branch from the earliest qualifying native-chat message', async () => {
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'fix-login' })
    const { deps } = makeRetryDeps({
      nativeReads: () => ({
        listSessionIds: async () => ['later', 'earlier'],
        readFirst: async (sessionId) =>
          sessionId === 'earlier'
            ? { prompt: 'Fix the login form', submittedAt: 110 }
            : { prompt: 'Polish the README', submittedAt: 120 }
      })
    })
    const result = await retryFirstWorkRename(WORKTREE_ID, deps)
    expect(result.outcome).toEqual({ kind: 'renamed' })
    expect(generateBranchNameMock.mock.calls[0][0].firstPrompt).toBe('Fix the login form')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'Nautilus-8', 'fix-login'],
      expect.anything()
    )
  })

  it('falls back to the branch changes and reports nothing-yet without generating', async () => {
    const { deps } = makeRetryDeps()
    const result = await retryFirstWorkRename(WORKTREE_ID, deps)
    expect(result.outcome).toEqual({ kind: 'nothing-yet' })
    expect(generateBranchNameMock).not.toHaveBeenCalled()

    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'login-form' })
    const withChanges = makeRetryDeps({ runGit: changesGit(' src/login.tsx | 4 ++--\n') })
    await expect(retryFirstWorkRename(WORKTREE_ID, withChanges.deps)).resolves.toMatchObject({
      outcome: { kind: 'renamed' }
    })
    expect(generateBranchNameMock.mock.calls[0][0]).toMatchObject({ fromChanges: true })
  })

  it('joins an automatic attempt for the same workspace instead of generating twice', async () => {
    const generation = deferred<{ success: true; slug: string }>()
    generateBranchNameMock.mockReturnValue(generation.promise)
    const { deps } = makeRetryDeps()
    const automatic = maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    await vi.waitFor(() => expect(generateBranchNameMock).toHaveBeenCalledTimes(1))
    const manual = retryFirstWorkRename(WORKTREE_ID, deps)
    generation.resolve({ success: true, slug: 'fix-auth' })
    await automatic
    await expect(manual).resolves.toMatchObject({ outcome: { kind: 'renamed' } })
    expect(generateBranchNameMock).toHaveBeenCalledTimes(1)
  })

  it('defers after the lookup deadline and never generates from a late read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sessions = deferred<string[]>()
    const listSessionIds = vi.fn(() => sessions.promise)
    const { deps } = makeRetryDeps({
      nativeReads: () => ({
        listSessionIds,
        readFirst: async () => ({ prompt: 'Late message', submittedAt: 200 })
      })
    })
    const first = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.advanceTimersByTimeAsync(FIRST_WORK_RETRY_LOOKUP_DEADLINE_MS)
    await expect(first).resolves.toMatchObject({
      outcome: { kind: 'deferred', reason: 'history-unreadable' }
    })
    // A second click while the read drains joins it rather than reading again.
    const second = retryFirstWorkRename(WORKTREE_ID, deps)
    expect(listSessionIds).toHaveBeenCalledTimes(1)
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'late-message' })
    sessions.resolve(['chat'])
    await expect(second).resolves.toMatchObject({ outcome: { kind: 'renamed' } })
    expect(generateBranchNameMock).toHaveBeenCalledTimes(1)
  })

  it('renames nothing when the branch stops being eligible during generation', async () => {
    const generation = deferred<{ success: true; slug: string }>()
    generateBranchNameMock.mockReturnValue(generation.promise)
    let eligible = true
    const { deps } = makeRetryDeps({
      runGit: changesGit(' a.ts | 1 +\n'),
      canRenameOrcaCreatedBranch: () => eligible
    })
    const result = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.waitFor(() => expect(generateBranchNameMock).toHaveBeenCalled())
    eligible = false
    generation.resolve({ success: true, slug: 'fix-auth' })
    await expect(result).resolves.toMatchObject({
      outcome: { kind: 'ineligible', reason: 'name-chosen' }
    })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['branch', '-m']),
      expect.anything()
    )
  })

  it('drops a replaced workspace’s late failure instead of writing it to the new row', async () => {
    const generation = deferred<{ success: false; error: string }>()
    generateBranchNameMock.mockReturnValue(generation.promise)
    let incarnation = 'A'
    const { deps, setRenameError } = makeRetryDeps({
      runGit: changesGit(' a.ts | 1 +\n'),
      readIncarnation: () => incarnation
    })
    const result = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.waitFor(() => expect(generateBranchNameMock).toHaveBeenCalled())
    incarnation = 'B'
    generation.resolve({ success: false, error: 'usage limit' })
    await expect(result).resolves.toMatchObject({ outcome: { kind: 'ineligible' } })
    expect(setRenameError).not.toHaveBeenCalled()
  })
})
