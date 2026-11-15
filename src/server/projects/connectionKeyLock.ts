import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface MaintenancePaths {
  lockPath: string;
  nextPath: string;
  prevPath: string;
  statePath: string;
  leasesDir: string;
}

export interface LeasePayload {
  pid: number;
  startedAt: string;
}

export function connectionKeyMaintenancePaths(keyPath: string): MaintenancePaths {
  const resolved = path.resolve(keyPath);
  return {
    lockPath: `${resolved}.lock`,
    nextPath: `${resolved}.next`,
    prevPath: `${resolved}.prev`,
    statePath: `${resolved}.state.json`,
    leasesDir: `${resolved}.leases`,
  };
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * Wraps an application connection-secret read or write in an exclusive lease
 * registered before checking for active key rotation/recovery maintenance.
 * Because rotation creates `.lock` before draining `.leases`, at least one
 * side is guaranteed to observe the other without a check-then-act window.
 */
export function withApplicationConnectionKeyLease<T>(
  keyPath: string,
  fn: () => T,
  onMaintenanceBlocked?: () => never,
): T {
  const { lockPath, statePath, leasesDir } = connectionKeyMaintenancePaths(keyPath);
  fs.mkdirSync(leasesDir, { recursive: true, mode: 0o700 });
  const leaseFile = path.join(leasesDir, `op-${process.pid}-${crypto.randomUUID()}.json`);
  const payload: LeasePayload = { pid: process.pid, startedAt: new Date().toISOString() };

  const fd = fs.openSync(leaseFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    if (fs.existsSync(lockPath) || fs.existsSync(statePath)) {
      if (onMaintenanceBlocked) onMaintenanceBlocked();
      throw new Error('Connection key maintenance is in progress; retry after rotation completes.');
    }
    return fn();
  } finally {
    try {
      if (fs.existsSync(leaseFile)) fs.unlinkSync(leaseFile);
    } catch {
      // Best-effort lease cleanup
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Waits for any in-flight application connection-secret leases to complete
 * after `.lock` has been acquired. Dead-PID leases are reclaimed safely.
 */
export function drainApplicationLeases(keyPath: string, timeoutMs = 2000): void {
  const { leasesDir } = connectionKeyMaintenancePaths(keyPath);
  if (!fs.existsSync(leasesDir)) return;

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const entries = fs.readdirSync(leasesDir);
    const liveLeases: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(leasesDir, entry);
      let pid: number | null = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as Partial<LeasePayload>;
        if (typeof parsed.pid === 'number') pid = parsed.pid;
      } catch {
        // Might be partially written or gone; treat briefly as live unless gone
        if (fs.existsSync(fullPath)) liveLeases.push(entry);
        continue;
      }

      if (pid !== null && !isPidAlive(pid)) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // Ignore concurrent unlink
        }
      } else {
        liveLeases.push(entry);
      }
    }

    if (liveLeases.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${liveLeases.length} in-flight application connection-secret operation(s) to drain.`,
      );
    }
    sleepSync(20);
  }
}
