import dagre from "@dagrejs/dagre";
import type { ConversationGraph, DependencyEdge, TurnNode } from "./types";

export const GRAPH_NODE_WIDTH = 220;
export const GRAPH_NODE_HEIGHT = 112;

export interface GraphPosition {
  x: number;
  y: number;
}

/** Position is presentation state only; dependency edges always come from the backend. */
export function layoutGraph(
  nodes: readonly TurnNode[],
  edges: readonly DependencyEdge[],
): Map<string, GraphPosition> {
  const layout = new dagre.graphlib.Graph();
  layout.setDefaultEdgeLabel(() => ({}));
  layout.setGraph({
    rankdir: "TB",
    nodesep: 28,
    ranksep: 42,
    marginx: 24,
    marginy: 24,
    ranker: "network-simplex",
  });

  const knownIds = new Set(nodes.map((node) => node.id));
  for (const node of [...nodes].sort((a, b) => a.sequence - b.sequence)) {
    layout.setNode(node.id, {
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
    });
  }
  for (const edge of edges) {
    if (knownIds.has(edge.source) && knownIds.has(edge.target)) {
      layout.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(layout);
  return new Map(
    nodes.map((node) => {
      const point = layout.node(node.id);
      return [
        node.id,
        {
          x: point.x - GRAPH_NODE_WIDTH / 2,
          y: point.y - GRAPH_NODE_HEIGHT / 2,
        },
      ];
    }),
  );
}

export function getNodeRelations(
  graph: ConversationGraph,
  selectedNodeId: string | null,
) {
  const selected = graph.nodes.find((node) => node.id === selectedNodeId);
  const parentIds = new Set(selected?.parent_ids ?? []);
  const contextIds = new Set(
    selected?.context.items.map((item) => item.node_id) ?? [],
  );
  const relatedIds = new Set([...parentIds, ...contextIds]);
  if (selected) relatedIds.add(selected.id);
  return { selected, parentIds, contextIds, relatedIds };
}

/** Descendants, rather than all later turns, would create a cycle as new parents. */
export function getDescendantIds(
  graph: ConversationGraph,
  nodeId: string,
): Set<string> {
  const knownIds = new Set(graph.nodes.map((node) => node.id));
  if (!knownIds.has(nodeId)) return new Set();
  const children = new Map<string, Set<string>>();
  const addChild = (parentId: string, childId: string) => {
    if (!knownIds.has(parentId) || !knownIds.has(childId)) return;
    if (!children.has(parentId)) children.set(parentId, new Set());
    children.get(parentId)!.add(childId);
  };
  for (const edge of graph.edges) addChild(edge.source, edge.target);
  for (const node of graph.nodes) {
    for (const parentId of node.parent_ids) addChild(parentId, node.id);
  }

  const visited = new Set([nodeId]);
  const pending = [nodeId];
  const descendants = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    for (const childId of children.get(pending[index]) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      descendants.add(childId);
      pending.push(childId);
    }
  }
  return descendants;
}

export function nodeMatchesSearch(node: TurnNode, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return (
    !normalized ||
    `${node.question}\n${node.answer}\n${node.summary}`
      .toLocaleLowerCase()
      .includes(normalized)
  );
}
