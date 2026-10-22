import { describe, expect, it } from "vitest";
import {
  GRAPH_NODE_HEIGHT,
  getDescendantIds,
  getNodeRelations,
  layoutGraph,
  nodeMatchesSearch,
} from "./graph";
import type { ConversationGraph, TurnNode } from "./types";

function turn(
  id: string,
  sequence: number,
  parents: string[] = [],
  context: string[] = [],
): TurnNode {
  return {
    id,
    sequence,
    conversation_id: "conversation",
    question: `问题 ${id}`,
    answer: `answer ${id}`,
    summary: "",
    parent_ids: parents,
    created_at: "2026-01-01T00:00:00Z",
    metrics: {},
    selection: {
      parent_ids: parents,
      candidate_ids: [],
      strategy: "test",
      reason: "",
      fallback_reason: null,
    },
    context: {
      items: context.map((node_id) => ({
        node_id,
        representation: "full",
        question: "",
        answer: "",
        estimated_tokens: 1,
      })),
      omitted_node_ids: [],
      estimated_input_tokens: 0,
      budget_tokens: 100,
      estimator: "test",
    },
  };
}

describe("conversation graph presentation", () => {
  it("places parents before their shared child and separates sibling branches", () => {
    const nodes = [
      turn("root", 1),
      turn("left", 2, ["root"]),
      turn("right", 3, ["root"]),
      turn("merge", 4, ["left", "right"]),
    ];
    const edges = [
      { source: "root", target: "left", kind: "depends_on" as const },
      { source: "root", target: "right", kind: "depends_on" as const },
      { source: "left", target: "merge", kind: "depends_on" as const },
      { source: "right", target: "merge", kind: "depends_on" as const },
    ];
    const positions = layoutGraph(nodes, edges);
    for (const edge of edges) {
      expect(positions.get(edge.target)!.y).toBeGreaterThan(
        positions.get(edge.source)!.y + GRAPH_NODE_HEIGHT,
      );
    }
    expect(positions.get("left")!.x).not.toBe(positions.get("right")!.x);
    expect(layoutGraph(nodes, edges)).toEqual(positions);
  });

  it("highlights actual context without including an unrelated sibling", () => {
    const graph: ConversationGraph = {
      conversation: {
        id: "conversation",
        title: "",
        instructions: "",
        created_at: "",
      },
      nodes: [
        turn("root", 1),
        turn("left", 2, ["root"]),
        turn("sibling", 3, ["root"]),
        turn("child", 4, ["left"], ["root", "left"]),
      ],
      edges: [],
    };
    const relations = getNodeRelations(graph, "child");
    expect([...relations.parentIds]).toEqual(["left"]);
    expect([...relations.contextIds]).toEqual(["root", "left"]);
    expect(relations.relatedIds.has("sibling")).toBe(false);
    expect(relations.relatedIds.has("child")).toBe(true);
    expect(getNodeRelations(graph, null).relatedIds.size).toBe(0);
  });

  it("searches original answers as well as questions, without case sensitivity", () => {
    const node = turn("branch", 1);
    expect(nodeMatchesSearch(node, "问题")).toBe(true);
    expect(nodeMatchesSearch(node, " ANSWER BRANCH ")).toBe(true);
    expect(nodeMatchesSearch(node, "missing")).toBe(false);
    expect(nodeMatchesSearch(node, "  ")).toBe(true);
  });

  it("excludes descendants to prevent cycles while allowing later unrelated parents", () => {
    const graph: ConversationGraph = {
      conversation: {
        id: "conversation",
        title: "",
        instructions: "",
        created_at: "",
      },
      nodes: [
        turn("target", 1),
        turn("child", 2, ["target"]),
        turn("grandchild", 3, ["child"]),
        turn("later-unrelated", 4),
      ],
      edges: [
        { source: "target", target: "child", kind: "depends_on" },
        { source: "child", target: "grandchild", kind: "depends_on" },
      ],
    };
    const descendants = getDescendantIds(graph, "target");
    expect(descendants).toEqual(new Set(["child", "grandchild"]));
    expect(descendants.has("later-unrelated")).toBe(false);
    expect(descendants.has("target")).toBe(false);
    expect(getDescendantIds(graph, "missing").size).toBe(0);
  });

  it("traverses parent links and guards against malformed cycles", () => {
    const graph: ConversationGraph = {
      conversation: {
        id: "conversation",
        title: "",
        instructions: "",
        created_at: "",
      },
      nodes: [turn("root", 1, ["child"]), turn("child", 2, ["root"])],
      edges: [],
    };
    expect(getDescendantIds(graph, "root")).toEqual(new Set(["child"]));
  });
});
