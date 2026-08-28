import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAutoRoute, AUTO_ROUTE } from '../src/control/autoRoutePolicy.js';

test('AutoRoutePolicy FORCE, BYPASS, and conservative AUTO contracts', () => {
  assert.deepEqual(decideAutoRoute('Use SuperGPT to refactor auth'), { mode: AUTO_ROUTE.FORCE, route: true });
  assert.deepEqual(decideAutoRoute('Do not use SuperGPT; change this typo'), { mode: AUTO_ROUTE.BYPASS, route: false });
  assert.equal(decideAutoRoute('Refactor authentication across server/client, preserve compatibility, add migration and tests').route, true);
  assert.equal(decideAutoRoute('Explain this stack trace').route, false);
  assert.equal(decideAutoRoute('Summarize this long non-engineering document about history and literature').route, false);
  assert.equal(decideAutoRoute('Build server and client settings components with tests').route, true);
  assert.equal(decideAutoRoute('Create a module with node:test coverage and run tests').route, true);
});
