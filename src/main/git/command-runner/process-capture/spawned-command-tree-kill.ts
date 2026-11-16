import { spawn, type ChildProcess } from 'node:child_process'
import { admitSelfInitiatedTreeKill } from '../../../pty/process-retirement/own-chromium-tree-kill-guard'
import {
  spawnOffMainThreadOnWindows,
  type WorkerThreadChildProcess
} from '../../../worker-thread-child-process/worker-thread-child-process'

const WINDOWS_TREE_KILL_WAIT_MS = 2_000

export function killSpawnedCommandTree(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'> | WorkerThreadChildProcess
): Promise<void> {
  if ('id' in child && child.pid === undefined && !child.closed) {
    // A worker-launched child reports its pid asynchronously; a root-only kill now would orphan its tree.
    return new Promise((resolve) => {
      const detach = (): void => {
        clearTimeout(stalled)
        child.off('spawn', onSpawn)
        child.off('close', onGone)
        child.off('error', onGone)
      }
      const onSpawn = (): void => {
        detach()
        void killSpawnedCommandTree(child).then(resolve)
      }
      // A lost worker reports an error and may never confirm a pid; the caller must still settle.
      const onGone = (): void => {
        detach()
        resolve()
      }
      // A stalled worker: queue a root kill (delivered once it spawns) and let the caller settle.
      const stalled = setTimeout(() => {
        detach()
        child.kill()
        resolve()
      }, WINDOWS_TREE_KILL_WAIT_MS)
      child.once('spawn', onSpawn)
      child.once('close', onGone)
      child.once('error', onGone)
    })
  }
  const pid = child.pid
  if (!pid || process.platform !== 'win32') {
    child.kill()
    return Promise.resolve()
  }
  // Windows may reuse the pid after exit while inherited pipes still delay close.
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) {
    child.kill()
    return Promise.resolve()
  }
  if (
    !admitSelfInitiatedTreeKill({ pid, site: 'git-command-tree-kill', scope: 'win-taskkill-tree' })
  ) {
    // A refused PID tree walk still permits handle-based root termination without risking a reused PID.
    child.kill()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let killer: ChildProcess | WorkerThreadChildProcess
    try {
      const args = ['/pid', String(pid), '/t', '/f']
      // Await Windows tree cleanup so shim/WSL descendants cannot outlive their probe.
      const offMain = spawnOffMainThreadOnWindows({ program: 'taskkill', args })
      if (offMain) {
        offMain.stdin.end()
        killer = offMain
      } else {
        const native = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true })
        if (!native || typeof native.unref !== 'function') {
          child.kill()
          resolve()
          return
        }
        native.unref()
        killer = native
      }
    } catch {
      child.kill()
      resolve()
      return
    }
    let settled = false
    let timer: NodeJS.Timeout | null = null
    let armed = false
    const finish = (fallbackToChildKill: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      killer.removeAllListeners()
      if (fallbackToChildKill) {
        child.kill()
      }
      resolve()
    }
    killer.once('error', () => finish(true))
    killer.once('close', (code) => finish(code !== 0))
    const arm = (): void => {
      if (armed || settled) {
        return
      }
      armed = true
      timer = setTimeout(() => {
        killer.kill()
        finish(true)
      }, WINDOWS_TREE_KILL_WAIT_MS)
    }
    // Give taskkill its full wait once it exists; a worker launch may first queue behind others.
    if ('id' in killer && killer.pid === undefined) {
      killer.once('spawn', arm)
      // If the worker stalls, settle the caller with a root kill and let taskkill run when dispatched.
      const dispatch = setTimeout(() => finish(true), WINDOWS_TREE_KILL_WAIT_MS)
      killer.once('spawn', () => clearTimeout(dispatch))
    } else {
      arm()
    }
  })
}
