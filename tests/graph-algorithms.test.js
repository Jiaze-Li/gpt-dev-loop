import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dijkstra,
  bfs,
  dfs,
  topologicalSort,
  hasCycle,
  stronglyConnectedComponents,
} from '../src/utils/graph-algorithms.js';

// Small builders keep the fixtures readable.
function weighted(entries) {
  return new Map(entries.map(([v, adj]) => [v, adj]));
}
function unweighted(entries) {
  return new Map(entries.map(([v, adj]) => [v, adj]));
}

test('dijkstra: computes shortest distances and predecessors', () => {
  const g = weighted([
    ['a', [['b', 1], ['c', 4]]],
    ['b', [['c', 2], ['d', 5]]],
    ['c', [['d', 1]]],
    ['d', []],
  ]);
  const { distances, predecessors } = dijkstra(g, 'a');
  assert.equal(distances.get('a'), 0);
  assert.equal(distances.get('b'), 1);
  assert.equal(distances.get('c'), 3);
  assert.equal(distances.get('d'), 4);
  assert.equal(predecessors.get('a'), null);
  assert.equal(predecessors.get('b'), 'a');
  assert.equal(predecessors.get('c'), 'b');
  assert.equal(predecessors.get('d'), 'c');
});

test('dijkstra: predecessor chain reconstructs the shortest path', () => {
  const g = weighted([
    ['a', [['b', 1], ['c', 4]]],
    ['b', [['c', 2], ['d', 5]]],
    ['c', [['d', 1]]],
    ['d', []],
  ]);
  const { predecessors } = dijkstra(g, 'a');
  const path = [];
  let cur = 'd';
  while (cur != null) {
    path.unshift(cur);
    cur = predecessors.get(cur);
  }
  assert.deepEqual(path, ['a', 'b', 'c', 'd']);
});

test('dijkstra: accepts a Map of neighbour -> weight', () => {
  const g = new Map([
    ['a', new Map([['b', 2], ['c', 7]])],
    ['b', new Map([['c', 1]])],
    ['c', new Map()],
  ]);
  const { distances } = dijkstra(g, 'a');
  assert.equal(distances.get('c'), 3);
});

test('dijkstra: unreachable and neighbour-only vertices', () => {
  const g = weighted([
    ['a', [['b', 1]]],
    ['b', [['c', 1]]],
    // c is neighbour-only; x is an isolated key.
    ['x', []],
  ]);
  const { distances, predecessors } = dijkstra(g, 'a');
  assert.equal(distances.get('c'), 2);
  assert.equal(distances.get('x'), Infinity);
  assert.equal(predecessors.get('x'), null);
  assert.ok(distances.has('c'));
});

test('dijkstra: zero-weight edges are allowed', () => {
  const g = weighted([
    ['a', [['b', 0]]],
    ['b', [['c', 0]]],
    ['c', []],
  ]);
  const { distances } = dijkstra(g, 'a');
  assert.equal(distances.get('b'), 0);
  assert.equal(distances.get('c'), 0);
});

test('dijkstra: rejects missing source, unknown source, and bad weights', () => {
  const g = weighted([['a', [['b', 1]]], ['b', []]]);
  assert.throws(() => dijkstra(g), /source/);
  assert.throws(() => dijkstra(g, 'zzz'), /not part of the graph/);
  assert.throws(() => dijkstra(new Map([['a', [['b', -1]]], ['b', []]]), 'a'), /negative/);
  assert.throws(() => dijkstra(new Map([['a', [['b', NaN]]], ['b', []]]), 'a'), /non-finite/);
  assert.throws(() => dijkstra(new Map([['a', [['b', Infinity]]], ['b', []]]), 'a'), /non-finite/);
  assert.throws(() => dijkstra(new Map([['a', [['b', '3']]], ['b', []]]), 'a'), /non-finite/);
  assert.throws(() => dijkstra([], 'a'), TypeError);
});

test('dijkstra: does not mutate the caller graph', () => {
  const inner = [['b', 1]];
  const g = new Map([['a', inner], ['b', []]]);
  dijkstra(g, 'a');
  assert.equal(g.size, 2);
  assert.deepEqual(inner, [['b', 1]]);
});

test('bfs: deterministic level order respecting adjacency order', () => {
  const g = unweighted([
    ['a', ['b', 'c']],
    ['b', ['d']],
    ['c', ['d', 'e']],
    ['d', []],
    ['e', []],
  ]);
  assert.deepEqual(bfs(g, 'a'), ['a', 'b', 'c', 'd', 'e']);
});

test('dfs: deterministic pre-order respecting adjacency order', () => {
  const g = unweighted([
    ['a', ['b', 'c']],
    ['b', ['d']],
    ['c', ['e']],
    ['d', []],
    ['e', []],
  ]);
  assert.deepEqual(dfs(g, 'a'), ['a', 'b', 'd', 'c', 'e']);
});

test('bfs/dfs: visit each reachable vertex once even with cycles', () => {
  const g = unweighted([
    ['a', ['b']],
    ['b', ['c', 'a']],
    ['c', ['b']],
  ]);
  assert.deepEqual(bfs(g, 'a'), ['a', 'b', 'c']);
  assert.deepEqual(dfs(g, 'a'), ['a', 'b', 'c']);
});

test('bfs/dfs: disconnected vertices are not reached from start', () => {
  const g = unweighted([
    ['a', ['b']],
    ['b', []],
    ['island', []],
  ]);
  assert.deepEqual(bfs(g, 'a'), ['a', 'b']);
  assert.deepEqual(dfs(g, 'a'), ['a', 'b']);
});

test('bfs/dfs: reject a start vertex absent from the graph', () => {
  const g = unweighted([['a', ['b']], ['b', []]]);
  assert.throws(() => bfs(g, 'nope'), /start vertex/);
  assert.throws(() => dfs(g, 'nope'), /start vertex/);
});

test('bfs/dfs: neighbour-only vertex is a valid start', () => {
  const g = unweighted([['a', ['b']]]);
  assert.deepEqual(bfs(g, 'b'), ['b']);
  assert.deepEqual(dfs(g, 'b'), ['b']);
});

test('topologicalSort: valid ordering places each edge tail before its head', () => {
  const g = unweighted([
    ['shirt', ['tie', 'belt']],
    ['tie', ['jacket']],
    ['belt', ['jacket']],
    ['jacket', []],
    ['socks', ['shoes']],
    ['shoes', []],
  ]);
  const order = topologicalSort(g);
  assert.equal(order.length, 6);
  assert.equal(new Set(order).size, 6);
  const pos = new Map(order.map((v, i) => [v, i]));
  for (const [v, adj] of g) {
    for (const w of adj) assert.ok(pos.get(v) < pos.get(w), `${v} before ${w}`);
  }
});

test('topologicalSort: includes isolated and neighbour-only vertices', () => {
  const g = unweighted([
    ['a', ['b']],
    ['loner', []],
  ]);
  const order = topologicalSort(g);
  assert.deepEqual(new Set(order), new Set(['a', 'b', 'loner']));
});

test('topologicalSort: throws on a cyclic graph', () => {
  const g = unweighted([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
  ]);
  assert.throws(() => topologicalSort(g), /cycle/);
});

test('hasCycle: detects self-loops', () => {
  assert.equal(hasCycle(new Map([['a', ['a']]])), true);
});

test('hasCycle: detects a multi-vertex cycle', () => {
  const g = unweighted([['a', ['b']], ['b', ['c']], ['c', ['a']]]);
  assert.equal(hasCycle(g), true);
});

test('hasCycle: detects a cycle in a disconnected component', () => {
  const g = unweighted([
    ['a', ['b']],
    ['b', []],
    ['x', ['y']],
    ['y', ['x']],
  ]);
  assert.equal(hasCycle(g), true);
});

test('hasCycle: false for a DAG with shared descendants', () => {
  const g = unweighted([
    ['a', ['b', 'c']],
    ['b', ['d']],
    ['c', ['d']],
    ['d', []],
  ]);
  assert.equal(hasCycle(g), false);
});

test('stronglyConnectedComponents: multi-component graph', () => {
  const g = unweighted([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a', 'd']],
    ['d', ['e']],
    ['e', ['d']],
    ['f', []],
  ]);
  const sccs = stronglyConnectedComponents(g);
  const asSets = sccs.map((c) => new Set(c)).sort((x, y) => y.size - x.size);
  assert.deepEqual(asSets[0], new Set(['a', 'b', 'c']));
  assert.deepEqual(asSets[1], new Set(['d', 'e']));
  assert.deepEqual(asSets[2], new Set(['f']));
  const flat = sccs.flat();
  assert.equal(flat.length, 6);
  assert.equal(new Set(flat).size, 6);
});

test('stronglyConnectedComponents: singletons, self-loop, neighbour-only', () => {
  const g = unweighted([
    ['a', ['b']],
    ['b', ['b']],
    // c is neighbour-only
    ['x', ['c']],
  ]);
  const sccs = stronglyConnectedComponents(g);
  const flat = sccs.flat();
  assert.deepEqual(new Set(flat), new Set(['a', 'b', 'x', 'c']));
  assert.equal(flat.length, 4);
  for (const c of sccs) assert.equal(c.length, 1);
});

test('stronglyConnectedComponents: empty graph yields no components', () => {
  assert.deepEqual(stronglyConnectedComponents(new Map()), []);
});

test('stronglyConnectedComponents: isolated vertices each form a component', () => {
  const g = unweighted([['a', []], ['b', []]]);
  const sccs = stronglyConnectedComponents(g);
  assert.deepEqual(sccs.map((c) => c.slice()).sort(), [['a'], ['b']]);
});

test('stronglyConnectedComponents: does not mutate the caller graph', () => {
  const adj = ['b'];
  const g = new Map([['a', adj], ['b', ['a']]]);
  stronglyConnectedComponents(g);
  assert.deepEqual(adj, ['b']);
  assert.equal(g.size, 2);
});

test('non-Map input is rejected by every entry point', () => {
  for (const fn of [bfs, dfs, topologicalSort, hasCycle, stronglyConnectedComponents]) {
    assert.throws(() => fn({}), TypeError);
  }
});
