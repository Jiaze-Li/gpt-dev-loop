import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureDashboardOpen, openBrowserUrl, stopStaleDashboardProcess } from '../src/dashboard/launcher.js';
import { getDashboardMeta } from '../src/dashboard/meta.js';
import { createSuperGptMcpServer } from '../src/mcp/supergptMcpServer.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import http from 'node:http';

test('1. 相同版本 -> 复用现有 Dashboard server (不杀进程，不重新 spawn)', async () => {
  const killedPids = [];
  const spawned = [];
  const openedUrls = [];

  const currentMeta = {
    name: 'supergpt-dashboard',
    dashboardVersion: '1.2.0',
    buildId: 'build-abc-123',
    pid: 99999,
  };

  const fakeProbe = async () => ({
    status: 'RUNNING_SUPERGPT',
    running: true,
    meta: { ...currentMeta },
  });

  const fakeSpawn = (cmd, args) => {
    spawned.push({ cmd, args });
    return { unref() {} };
  };

  const fakeOpen = (url) => {
    openedUrls.push(url);
    return true;
  };

  const fakeKill = (pid) => {
    killedPids.push(pid);
  };

  const res = await ensureDashboardOpen({
    workflowId: 'wf-agy-test-1111-2222-3333-444455556666',
    port: 4317,
    _probe: fakeProbe,
    _spawn: fakeSpawn,
    _openBrowser: fakeOpen,
    _kill: fakeKill,
    _currentMeta: () => currentMeta,
  });

  assert.equal(res.opened, false, 'Reusing an existing server must not open a browser tab');
  assert.equal(res.reused, true);
  assert.equal(res.serverStarted, false);
  assert.equal(killedPids.length, 0, 'Must NOT kill same version process');
  assert.equal(spawned.length, 0, 'Must NOT spawn second server');
  assert.deepEqual(openedUrls, [], 'No browser open when the server is reused');
  assert.equal(res.workflowUrl, 'http://127.0.0.1:4317/workflow/wf-agy-test-1111-2222-3333-444455556666');
});

test('2. 旧版本 -> 自动安全停止旧 SuperGPT PID 并拉起新版本 server', async () => {
  const killedPids = [];
  const spawned = [];
  const openedUrls = [];
  let probeCount = 0;

  const staleMeta = {
    name: 'supergpt-dashboard',
    dashboardVersion: '1.0.0', // Old version
    buildId: 'old-build-000',
    pid: 88888,
  };

  const currentMeta = {
    name: 'supergpt-dashboard',
    dashboardVersion: '1.2.0',
    buildId: 'new-build-111',
    pid: 99999,
  };

  const fakeProbe = async () => {
    probeCount++;
    if (probeCount === 1) {
      // First probe: returns stale server
      return { status: 'RUNNING_SUPERGPT', running: true, meta: staleMeta };
    }
    if (probeCount === 2) {
      // Second probe after kill: stopped
      return { status: 'NOT_RUNNING', running: false };
    }
    // Subsequent probes: new server running
    return { status: 'RUNNING_SUPERGPT', running: true, meta: currentMeta };
  };

  const fakeSpawn = (cmd, args) => {
    spawned.push({ cmd, args });
    return { unref() {} };
  };

  const fakeOpen = (url) => {
    openedUrls.push(url);
    return true;
  };

  const fakeKill = (pid) => {
    killedPids.push(pid);
  };

  const res = await ensureDashboardOpen({
    workflowId: 'wf-agy-test-1111-2222-3333-444455556666',
    port: 4317,
    _probe: fakeProbe,
    _spawn: fakeSpawn,
    _openBrowser: fakeOpen,
    _kill: fakeKill,
    _currentMeta: () => currentMeta,
  });

  assert.equal(res.opened, true);
  assert.equal(res.serverStarted, true);
  assert.deepEqual(killedPids, [88888], 'Must kill exactly the verified stale SuperGPT PID');
  assert.equal(spawned.length, 1, 'Must spawn fresh server');
  assert.deepEqual(openedUrls, ['http://127.0.0.1:4317/'], 'Replacing a stale server opens the home page once');
});

test('3. 未知第三方服务占用端口 -> 不杀进程，返回 warning，不影响 workflow', async () => {
  const killedPids = [];
  const spawned = [];
  const openedUrls = [];

  const foreignProbe = async () => ({
    status: 'RUNNING_FOREIGN',
    running: true,
    meta: { some: 'other-service' },
  });

  const fakeSpawn = (cmd, args) => { spawned.push({ cmd, args }); return { unref() {} }; };
  const fakeOpen = (url) => { openedUrls.push(url); return true; };
  const fakeKill = (pid) => { killedPids.push(pid); };

  const res = await ensureDashboardOpen({
    workflowId: 'wf-agy-test-1111-2222-3333-444455556666',
    port: 4317,
    _probe: foreignProbe,
    _spawn: fakeSpawn,
    _openBrowser: fakeOpen,
    _kill: fakeKill,
  });

  assert.equal(res.serverStarted, false);
  assert.equal(res.occupiedByForeignProcess, true);
  assert.ok(res.warning);
  assert.equal(killedPids.length, 0, 'Must NOT kill foreign process');
  assert.equal(spawned.length, 0, 'Must NOT spawn conflicting server');
});

test('4. 页面与 API 响应设置 no-cache/no-store 避免 stale cache', async () => {
  const dashboard = createDashboardServer({ port: 4398, host: '127.0.0.1' });
  const { url } = await dashboard.start();

  try {
    const fetchHeaders = (path) => new Promise((resolve, reject) => {
      http.get(`${url}${path}`, (res) => {
        res.resume();
        resolve(res.headers);
      }).on('error', reject);
    });

    const metaHeaders = await fetchHeaders('/api/meta');
    assert.match(metaHeaders['cache-control'], /no-cache.*no-store.*must-revalidate/i);
    assert.equal(metaHeaders['pragma'], 'no-cache');

    const htmlHeaders = await fetchHeaders('/');
    assert.match(htmlHeaders['cache-control'], /no-cache.*no-store.*must-revalidate/i);
    assert.equal(htmlHeaders['pragma'], 'no-cache');

    const workflowHtmlHeaders = await fetchHeaders('/workflow/wf-test-1');
    assert.match(workflowHtmlHeaders['cache-control'], /no-cache.*no-store.*must-revalidate/i);
  } finally {
    await dashboard.close();
  }
});

test('5. 非法 workflowId 与 host 严格拒绝', async () => {
  await assert.rejects(
    async () => ensureDashboardOpen({ workflowId: '../../etc/passwd' }),
    /WorkflowIdError|path separator/i
  );
  await assert.rejects(
    async () => ensureDashboardOpen({ workflowId: 'wf-agy-safe-1111-2222-3333-444455556666', host: '0.0.0.0' }),
    /Security Error: Dashboard host must be loopback/
  );
});

test('6. Dashboard 启动失败或 browser open 失败不影响 workflow', async () => {
  const failingProbe = async () => ({ status: 'NOT_RUNNING', running: false });
  const failingSpawn = () => { throw new Error('spawn failed'); };
  const failingOpen = () => false;

  const res = await ensureDashboardOpen({
    workflowId: 'wf-agy-safe-1111-2222-3333-444455556666',
    _probe: failingProbe,
    _spawn: failingSpawn,
    _openBrowser: failingOpen,
  });

  assert.equal(res.opened, false);
  assert.equal(res.serverStarted, false);
  assert.ok(res.error);
});

test('7. openBrowserUrl executes platform-specific opener with detached/unref', () => {
  const spawned = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return { unref() {} };
  };

  openBrowserUrl('http://127.0.0.1:4317/workflow/wf-1', { platform: 'darwin', _spawn: fakeSpawn });
  assert.equal(spawned[0].cmd, 'open');

  openBrowserUrl('http://127.0.0.1:4317/workflow/wf-2', { platform: 'win32', _spawn: fakeSpawn });
  assert.equal(spawned[1].cmd, 'cmd.exe');

  openBrowserUrl('http://127.0.0.1:4317/workflow/wf-3', { platform: 'linux', _spawn: fakeSpawn });
  assert.equal(spawned[2].cmd, 'xdg-open');
});

// Shared stateful harness: the Dashboard server starts NOT running; the first
// call that spawns it flips a stateful probe to RUNNING_SUPERGPT so every later
// call reuses it.
function makeHarness() {
  const currentMeta = {
    name: 'supergpt-dashboard',
    dashboardVersion: '9.9.9',
    buildId: 'build-current',
    pid: 4242,
  };
  let running = false;
  const spawned = [];
  const openedUrls = [];

  const probe = async () => (running
    ? { status: 'RUNNING_SUPERGPT', running: true, meta: { ...currentMeta } }
    : { status: 'NOT_RUNNING', running: false });

  const spawn = (cmd, args) => {
    spawned.push({ cmd, args });
    running = true; // server is now up for subsequent probes
    return { unref() {} };
  };

  const open = (u) => { openedUrls.push(u); return true; };

  const run = (workflowId) => ensureDashboardOpen({
    workflowId,
    port: 4317,
    timeoutMs: 500,
    _probe: probe,
    _spawn: spawn,
    _openBrowser: open,
    _kill: () => {},
    _currentMeta: () => currentMeta,
  });

  return { run, spawned, openedUrls };
}

test('8. 首个 workflow 启动 Dashboard 并恰好打开一次首页', async () => {
  const h = makeHarness();
  const res = await h.run('wf-agy-first-1111-2222-3333-444455556666');

  assert.equal(res.serverStarted, true);
  assert.equal(res.opened, true);
  assert.deepEqual(h.openedUrls, ['http://127.0.0.1:4317/']);
  assert.equal(h.spawned.length, 1);
});

test('9. 第二个 workflow 复用 server 且不再打开新 Tab', async () => {
  const h = makeHarness();
  await h.run('wf-agy-first-1111-2222-3333-444455556666');
  const res = await h.run('wf-agy-second-1111-2222-3333-444455556666');

  assert.equal(res.reused, true);
  assert.equal(res.serverStarted, false);
  assert.equal(res.opened, false);
  assert.deepEqual(h.openedUrls, ['http://127.0.0.1:4317/'], 'Still exactly one browser open');
  assert.equal(h.spawned.length, 1, 'No second server spawned');
});

test('10. 连续 10 个 workflow 总计只打开一次浏览器、只启动一个 server', async () => {
  const h = makeHarness();
  for (let i = 0; i < 10; i++) {
    await h.run(`wf-agy-loop${i}-1111-2222-3333-444455556666`);
  }
  assert.equal(h.openedUrls.length, 1, 'Exactly one browser open across 10 workflows');
  assert.deepEqual(h.openedUrls, ['http://127.0.0.1:4317/']);
  assert.equal(h.spawned.length, 1, 'Exactly one Dashboard server started');
});
