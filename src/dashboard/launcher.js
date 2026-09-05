// SuperGPT Local Dashboard Auto-Launcher with Stale Process Replacement.
//
// Ensures the current version of the Dashboard HTTP server is running on 127.0.0.1:4317.
// - Same version running: Reuses existing server (idempotent).
// - Stale SuperGPT version running: Gracefully terminates only the verified SuperGPT PID and launches fresh server.
// - Unknown third-party service occupying port: Fails closed/warns without killing foreign process.
// - Zero model tokens, detached, non-blocking, fail-safe.

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateWorkflowId } from '../orchestrator/workflowId.js';
import { SUPERGPT_WORKTREE_ROOT } from '../orchestrator/workflowWorktree.js';
import { getDashboardMeta, DASHBOARD_VERSION, computeDashboardBuildId } from './meta.js';
import { recordDashboardFocus } from './focus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_BIN = path.resolve(__dirname, '../../bin/supergpt-dashboard.js');

export function probeDashboardMeta({ port = 4317, host = '127.0.0.1', timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/api/meta`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ status: 'RUNNING_FOREIGN', running: true });
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data && data.name === 'supergpt-dashboard' && data.dashboardVersion && data.buildId) {
            resolve({ status: 'RUNNING_SUPERGPT', meta: data, running: true });
          } else {
            resolve({ status: 'RUNNING_FOREIGN', meta: data, running: true });
          }
        } catch {
          resolve({ status: 'RUNNING_FOREIGN', running: true });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'NOT_RUNNING', running: false });
    });

    req.on('error', (err) => {
      // ECONNREFUSED means nothing is listening on the port
      if (err.code === 'ECONNREFUSED') {
        resolve({ status: 'NOT_RUNNING', running: false });
      } else {
        resolve({ status: 'NOT_RUNNING', running: false });
      }
    });
  });
}

export async function stopStaleDashboardProcess(pid, { port = 4317, host = '127.0.0.1', timeoutMs = 1500, _kill = process.kill, _probe = probeDashboardMeta } = {}) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    _kill(pid, 'SIGTERM');
  } catch {
    // Process might have already exited
    return true;
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
    const p = await _probe({ port, host });
    if (!p.running) return true;
  }
  return true;
}

export function openBrowserUrl(url, { platform = process.platform, _spawn = spawn } = {}) {
  try {
    let cmd;
    let args;

    if (platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (platform === 'win32') {
      cmd = 'cmd.exe';
      args = ['/c', 'start', '""', url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }

    const child = _spawn(cmd, args, { detached: true, stdio: 'ignore' });
    if (typeof child?.unref === 'function') {
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}

export async function ensureDashboardOpen({
  workflowId,
  kind = 'USER',
  root = SUPERGPT_WORKTREE_ROOT,
  port = 4317,
  host = '127.0.0.1',
  openBrowser = true,
  timeoutMs = 2500,
  _probe = probeDashboardMeta,
  _spawn = spawn,
  _openBrowser = openBrowserUrl,
  _kill = process.kill,
  _currentMeta = getDashboardMeta,
} = {}) {
  // 1. Validate workflowId and host security
  validateWorkflowId(workflowId);

  // Record user focus if this is a USER workflow
  recordDashboardFocus({ workflowId, kind, root });

  const allowedHosts = ['127.0.0.1', 'localhost', '::1'];
  if (!allowedHosts.includes(host)) {
    throw new Error(`Security Error: Dashboard host must be loopback (127.0.0.1/localhost), received '${host}'`);
  }

  // The browser is only ever pointed at the Dashboard home page. The
  // /workflow/<id> route stays available for manual navigation, but auto-open
  // must not spawn a new tab per workflow.
  const url = `http://${host}:${port}/`;
  const workflowUrl = `http://${host}:${port}/workflow/${encodeURIComponent(workflowId)}`;

  try {
    const probe = await _probe({ port, host });
    const current = _currentMeta();

    if (probe.status === 'RUNNING_SUPERGPT') {
      // 2A. SuperGPT Dashboard is running -> Compare version and buildId
      const isCurrentVersion =
        probe.meta?.dashboardVersion === current.dashboardVersion &&
        probe.meta?.buildId === current.buildId;

      if (isCurrentVersion) {
        // Exact match: reuse existing server. This call did NOT start a server,
        // so no browser tab is opened.
        return {
          opened: false,
          url,
          workflowUrl,
          serverStarted: false,
          reused: true,
        };
      }

      // Stale version: gracefully kill only the verified SuperGPT PID
      await stopStaleDashboardProcess(probe.meta?.pid, { port, host, _kill, _probe });
    } else if (probe.status === 'RUNNING_FOREIGN') {
      // 2B. Occupied by unknown foreign process -> DO NOT KILL foreign process
      return {
        opened: false,
        url,
        workflowUrl,
        serverStarted: false,
        occupiedByForeignProcess: true,
        warning: `Port ${port} is occupied by an unverified third-party service. Foreign process was not stopped.`,
      };
    }

    // 3. Launch fresh background server
    const child = _spawn(process.execPath, [DASHBOARD_BIN, `--port=${port}`, `--host=${host}`], {
      detached: true,
      stdio: 'ignore',
    });
    if (typeof child?.unref === 'function') {
      child.unref();
    }

    // Wait until healthy & responding with current metadata
    const startTime = Date.now();
    let serverReady = false;
    while (Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
      const freshProbe = await _probe({ port, host });
      if (freshProbe.status === 'RUNNING_SUPERGPT') {
        serverReady = true;
        break;
      }
    }

    // 4. Open browser -- only because THIS call actually started a new server.
    let opened = false;
    if (openBrowser) {
      opened = _openBrowser(url, { _spawn });
    }

    return {
      opened,
      url,
      workflowUrl,
      serverStarted: true,
      serverReady,
    };
  } catch (err) {
    // Fail-safe: Return clean warning object without crashing caller
    return {
      opened: false,
      url,
      workflowUrl,
      serverStarted: false,
      error: err.message,
    };
  }
}
