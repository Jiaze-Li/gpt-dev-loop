// Dependency-free graph algorithms over an adjacency-list `Map`.
//
// Adjacency-list contract
// -----------------------
// A graph is a `Map` whose keys are vertices. For the unweighted algorithms
// (`bfs`, `dfs`, `topologicalSort`, `hasCycle`, `stronglyConnectedComponents`)
// each value is an iterable of neighbour vertices. For `dijkstra` each value is
// an iterable of `[neighbour, weight]` pairs, which also covers a
// `Map<neighbour, weight>`. Any vertex that only ever appears as a neighbour is
// still a real vertex of the graph. None of these functions mutate the graph or
// any collection owned by the caller.
//
// The repository package is ESM (`"type": "module"`), so this module uses ESM
// named exports rather than CommonJS `module.exports`.

'use strict';

function assertGraph(graph) {
  if (!(graph instanceof Map)) {
    throw new TypeError('graph must be a Map of vertex -> neighbours');
  }
}

// The complete vertex set: every key plus every vertex mentioned only as a
// neighbour, in deterministic discovery order (keys first, then neighbour-only
// vertices in the order they are first seen).
function collectVertices(graph, { weighted = false } = {}) {
  const vertices = new Set(graph.keys());
  for (const neighbours of graph.values()) {
    for (const entry of iterateNeighbours(neighbours, weighted)) {
      vertices.add(entry.vertex);
    }
  }
  return vertices;
}

function* iterateNeighbours(neighbours, weighted) {
  if (neighbours == null) return;
  if (weighted) {
    for (const pair of neighbours) {
      if (!Array.isArray(pair) && !(pair && typeof pair[Symbol.iterator] === 'function')) {
        throw new TypeError('weighted neighbours must be [vertex, weight] pairs');
      }
      const [vertex, weight] = pair;
      yield { vertex, weight };
    }
  } else {
    for (const vertex of neighbours) {
      yield { vertex };
    }
  }
}

function neighboursOf(graph, vertex, weighted) {
  if (!graph.has(vertex)) return [];
  return [...iterateNeighbours(graph.get(vertex), weighted)];
}

// Binary min-heap keyed by numeric priority, with a stable tie-break on
// insertion sequence so output stays deterministic.
class MinHeap {
  constructor() {
    this._items = [];
    this._seq = 0;
  }

  get size() {
    return this._items.length;
  }

  push(value, priority) {
    const node = { value, priority, seq: this._seq++ };
    const items = this._items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._less(items[i], items[parent])) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else break;
    }
  }

  pop() {
    const items = this._items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < items.length && this._less(items[left], items[smallest])) smallest = left;
        if (right < items.length && this._less(items[right], items[smallest])) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top.value;
  }

  _less(a, b) {
    if (a.priority !== b.priority) return a.priority < b.priority;
    return a.seq < b.seq;
  }
}

/**
 * Dijkstra shortest paths for a directed graph with non-negative weights.
 * Returns `{ distances, predecessors }` where both are `Map`s covering every
 * vertex of the graph: unreachable vertices map to `Infinity` / `null`, and the
 * source's predecessor is `null`.
 */
export function dijkstra(graph, source) {
  assertGraph(graph);
  if (arguments.length < 2) {
    throw new Error('dijkstra requires a source vertex');
  }
  const vertices = collectVertices(graph, { weighted: true });
  if (!vertices.has(source)) {
    throw new Error('source vertex is not part of the graph');
  }

  const distances = new Map();
  const predecessors = new Map();
  for (const v of vertices) {
    distances.set(v, Infinity);
    predecessors.set(v, null);
  }
  distances.set(source, 0);

  const heap = new MinHeap();
  heap.push(source, 0);
  const settled = new Set();

  while (heap.size > 0) {
    const u = heap.pop();
    if (settled.has(u)) continue;
    settled.add(u);
    const du = distances.get(u);

    for (const { vertex: v, weight } of iterateNeighbours(graph.get(u), true)) {
      if (typeof weight !== 'number' || Number.isNaN(weight) || !Number.isFinite(weight)) {
        throw new RangeError(`edge ${String(u)} -> ${String(v)} has a non-finite weight`);
      }
      if (weight < 0) {
        throw new RangeError(`edge ${String(u)} -> ${String(v)} has a negative weight`);
      }
      const candidate = du + weight;
      if (candidate < distances.get(v)) {
        distances.set(v, candidate);
        predecessors.set(v, u);
        heap.push(v, candidate);
      }
    }
  }

  return { distances, predecessors };
}

/** Deterministic breadth-first traversal, returning the visited vertices. */
export function bfs(graph, start) {
  assertGraph(graph);
  const vertices = collectVertices(graph);
  if (!vertices.has(start)) {
    throw new Error('start vertex is not part of the graph');
  }

  const visited = new Set([start]);
  const order = [];
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    order.push(u);
    for (const { vertex: v } of iterateNeighbours(graph.get(u), false)) {
      if (!visited.has(v)) {
        visited.add(v);
        queue.push(v);
      }
    }
  }
  return order;
}

/**
 * Deterministic depth-first traversal (pre-order), returning the visited
 * vertices. Implemented with an explicit stack so it does not depend on the
 * call-stack depth.
 */
export function dfs(graph, start) {
  assertGraph(graph);
  const vertices = collectVertices(graph);
  if (!vertices.has(start)) {
    throw new Error('start vertex is not part of the graph');
  }

  const visited = new Set();
  const order = [];
  const stack = [start];
  while (stack.length > 0) {
    const u = stack.pop();
    if (visited.has(u)) continue;
    visited.add(u);
    order.push(u);
    const neighbours = neighboursOf(graph, u, false);
    for (let i = neighbours.length - 1; i >= 0; i--) {
      if (!visited.has(neighbours[i].vertex)) {
        stack.push(neighbours[i].vertex);
      }
    }
  }
  return order;
}

/**
 * Topological ordering of a directed acyclic graph (Kahn's algorithm). The
 * result contains every vertex exactly once, including isolated and
 * neighbour-only vertices. Throws when the graph contains a cycle.
 */
export function topologicalSort(graph) {
  assertGraph(graph);
  const vertices = [...collectVertices(graph)];
  const indegree = new Map(vertices.map((v) => [v, 0]));
  const adj = new Map(vertices.map((v) => [v, neighboursOf(graph, v, false).map((n) => n.vertex)]));

  for (const v of vertices) {
    for (const w of adj.get(v)) {
      indegree.set(w, indegree.get(w) + 1);
    }
  }

  const queue = vertices.filter((v) => indegree.get(v) === 0);
  let head = 0;
  const order = [];
  while (head < queue.length) {
    const u = queue[head++];
    order.push(u);
    for (const w of adj.get(u)) {
      const d = indegree.get(w) - 1;
      indegree.set(w, d);
      if (d === 0) queue.push(w);
    }
  }

  if (order.length !== vertices.length) {
    throw new Error('graph contains a cycle; no topological ordering exists');
  }
  return order;
}

/**
 * Whether a directed graph contains a cycle. Detects self-loops, multi-vertex
 * cycles and cycles in disconnected components.
 */
export function hasCycle(graph) {
  assertGraph(graph);
  const vertices = [...collectVertices(graph)];
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(vertices.map((v) => [v, WHITE]));

  for (const root of vertices) {
    if (color.get(root) !== WHITE) continue;
    const stack = [{ vertex: root, neighbours: neighboursOf(graph, root, false), index: 0 }];
    color.set(root, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index < frame.neighbours.length) {
        const w = frame.neighbours[frame.index++].vertex;
        const c = color.get(w);
        if (c === GRAY) return true;
        if (c === WHITE) {
          color.set(w, GRAY);
          stack.push({ vertex: w, neighbours: neighboursOf(graph, w, false), index: 0 });
        }
      } else {
        color.set(frame.vertex, BLACK);
        stack.pop();
      }
    }
  }
  return false;
}

/**
 * Strongly connected components via Tarjan's algorithm (iterative). Returns an
 * array of component arrays covering every vertex exactly once. Supports
 * isolated vertices, self-loops, disconnected graphs and neighbour-only
 * vertices.
 */
export function stronglyConnectedComponents(graph) {
  assertGraph(graph);
  const vertices = [...collectVertices(graph)];
  const adj = new Map(vertices.map((v) => [v, neighboursOf(graph, v, false).map((n) => n.vertex)]));

  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const tarjanStack = [];
  const components = [];
  let counter = 0;

  for (const root of vertices) {
    if (indices.has(root)) continue;
    const work = [{ vertex: root, index: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.vertex;

      if (frame.index === 0) {
        indices.set(v, counter);
        lowlink.set(v, counter);
        counter++;
        tarjanStack.push(v);
        onStack.add(v);
      }

      const neighbours = adj.get(v);
      if (frame.index < neighbours.length) {
        const w = neighbours[frame.index++];
        if (!indices.has(w)) {
          work.push({ vertex: w, index: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
        }
        continue;
      }

      // Done exploring v: fold its lowlink into its parent, then close a
      // component if v is a root.
      if (lowlink.get(v) === indices.get(v)) {
        const component = [];
        for (;;) {
          const w = tarjanStack.pop();
          onStack.delete(w);
          component.push(w);
          if (w === v) break;
        }
        components.push(component);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].vertex;
        lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(v)));
      }
    }
  }

  return components;
}
