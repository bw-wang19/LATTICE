import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Check,
  Focus,
  GitBranch,
  LayoutGrid,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Workflow,
  X,
} from "lucide-react";
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  getNodeRelations,
  layoutGraph,
  nodeMatchesSearch,
} from "../graph";
import type {
  ConversationGraph,
  ParentControls,
  ParentMode,
  TurnNode,
} from "../types";
import "@xyflow/react/dist/style.css";
import "./graph.css";

interface GraphPanelProps {
  graph: ConversationGraph;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  focusMode: boolean;
  onToggleFocus: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  parentControl: ParentControls;
}

interface TurnNodeData extends Record<string, unknown> {
  turn: TurnNode;
  isCurrent: boolean;
  isParent: boolean;
  isContext: boolean;
  isDimmed: boolean;
  isSearchMatch: boolean;
  isPinned: boolean;
  picking: boolean;
  showParentControl: boolean;
  canToggleParent: boolean;
  parentDisabledReason: string | null;
  onToggleParent: (id: string) => void;
}

type TurnFlowNode = Node<TurnNodeData, "turn">;

const TurnCard = memo(function TurnCard({ data }: NodeProps<TurnFlowNode>) {
  const {
    turn,
    isCurrent,
    isParent,
    isContext,
    isDimmed,
    isSearchMatch,
    isPinned,
    picking,
    showParentControl,
    canToggleParent,
    parentDisabledReason,
    onToggleParent,
  } = data;
  const status = isCurrent
    ? "当前节点"
    : isParent
      ? "直接父节点"
      : isContext
        ? "已用上下文"
        : "";
  const classes = [
    "dag-card",
    isCurrent && "dag-card--selected",
    isParent && !isCurrent && "dag-card--parent",
    isContext && !isParent && !isCurrent && "dag-card--context",
    isDimmed && "dag-card--dimmed",
    isSearchMatch && "dag-card--match",
    isPinned && "dag-card--pinned",
    picking && "dag-card--picking",
    picking && !canToggleParent && "dag-card--unavailable",
    turn.stale && "dag-card--stale",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      data-parent-selected={isPinned}
      title={[turn.question, picking && parentDisabledReason]
        .filter(Boolean)
        .join("\n")}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="dag-card-topline">
        <span className="dag-card-number">
          <span />
          {String(turn.sequence).padStart(2, "0")}
        </span>
        <div className="dag-card-badges">
          {status && <span className="dag-card-status">{status}</span>}
          <span className="dag-card-version" title="当前回答版本">
            v{turn.revision ?? 1}
          </span>
          {turn.stale && (
            <span
              className="dag-card-stale"
              title={turn.stale_reason ?? "上游内容已变更，请重新生成此节点"}
            >
              待更新
            </span>
          )}
          {picking ? (
            <span
              className={`dag-parent-check${isPinned ? " is-checked" : ""}${!canToggleParent ? " is-disabled" : ""}`}
              aria-hidden="true"
            >
              {isPinned && <Check size={11} />}
            </span>
          ) : (
            showParentControl && (
              <button
                className={`dag-parent-toggle nodrag nopan${isPinned ? " is-checked" : ""}`}
                type="button"
                aria-label={`${isPinned ? "取消父节点" : "选为父节点"}：第 ${turn.sequence} 轮`}
                aria-pressed={isPinned}
                disabled={!canToggleParent}
                title={
                  parentDisabledReason ??
                  (isPinned ? "取消指定父节点" : "指定为生成时使用的父节点")
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (canToggleParent) onToggleParent(turn.id);
                }}
              >
                {isPinned ? <Check size={11} /> : <Plus size={11} />}
              </button>
            )
          )}
        </div>
      </div>
      <div className="dag-card-question">{turn.question}</div>
      <div className="dag-card-footer">
        <span>
          <GitBranch size={11} aria-hidden="true" />
          {turn.parent_ids.length
            ? `${turn.parent_ids.length} 个父节点`
            : "独立话题"}
        </span>
        {picking && parentDisabledReason ? (
          <span className="dag-card-disabled-reason">
            {isPinned && canToggleParent
              ? parentDisabledReason
              : turn.stale
                ? "过期节点不可选"
                : parentDisabledReason}
          </span>
        ) : (
          <span>{turn.context.items.length} 段上下文</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { turn: TurnCard };

function GraphCanvas({
  graph,
  selectedNodeId,
  onSelectNode,
  focusMode,
  onToggleFocus,
  searchQuery,
  onSearchChange,
  parentControl,
}: GraphPanelProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<TurnFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const { fitView, setCenter, getNode, getZoom, zoomIn, zoomOut } =
    useReactFlow<TurnFlowNode>();
  const previousLayoutKey = useRef("");
  const graphClick = useRef(false);
  const lastSelection = useRef<string | null>(null);
  const previousCenterTopology = useRef<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const topologyKey = `${graph.conversation.id}:${graph.nodes.map((node) => node.id).join(",")}:${graph.edges.map((edge) => `${edge.source}>${edge.target}`).join(",")}`;
  const layoutKey = `${topologyKey}:${layoutRevision}`;
  const relations = useMemo(
    () => getNodeRelations(graph, selectedNodeId),
    [graph, selectedNodeId],
  );
  const hasSearch = Boolean(searchQuery.trim());
  const matchedCount = useMemo(
    () =>
      graph.nodes.filter((node) => nodeMatchesSearch(node, searchQuery)).length,
    [graph.nodes, searchQuery],
  );
  const parentModeLabel = {
    auto: "自动识别",
    augment: "自动 + 指定",
    manual: "仅用指定",
  }[parentControl.mode];
  const disabledParentIds = useMemo(
    () => new Set(parentControl.disabledIds),
    [parentControl.disabledIds],
  );
  const pinnedIds = useMemo(
    () => new Set(parentControl.selectedIds),
    [parentControl.selectedIds],
  );
  const parentActionsDisabled = parentControl.busy || parentControl.readOnly;
  const activateNode = useCallback(
    (id: string) => {
      if (parentControl.picking) {
        const turn = graph.nodes.find((node) => node.id === id);
        if (
          !parentActionsDisabled &&
          turn &&
          (pinnedIds.has(id) || (!turn.stale && !disabledParentIds.has(id)))
        )
          parentControl.onToggleParent(id);
        return;
      }
      graphClick.current = id !== selectedNodeId;
      onSelectNode(id);
    },
    [
      parentControl,
      graph.nodes,
      parentActionsDisabled,
      disabledParentIds,
      pinnedIds,
      selectedNodeId,
      onSelectNode,
    ],
  );

  const handleFit = useCallback(() => {
    void fitView({ padding: 0.12, duration: 450, maxZoom: 1.1 });
  }, [fitView]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let timeout: number | undefined;
    let previousWidth = 0;
    let previousHeight = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (
        width < 1 ||
        height < 1 ||
        (Math.abs(width - previousWidth) < 1 &&
          Math.abs(height - previousHeight) < 1)
      )
        return;
      previousWidth = width;
      previousHeight = height;
      window.clearTimeout(timeout);
      timeout = window.setTimeout(handleFit, 180);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [handleFit]);

  useEffect(() => {
    const shouldLayout = previousLayoutKey.current !== layoutKey;
    previousLayoutKey.current = layoutKey;
    const positions = shouldLayout
      ? layoutGraph(graph.nodes, graph.edges)
      : null;
    const matchingIds = new Set(
      graph.nodes
        .filter((turn) => nodeMatchesSearch(turn, searchQuery))
        .map((turn) => turn.id),
    );
    setNodes((currentNodes) => {
      const currentPositions = new Map(
        currentNodes.map((node) => [node.id, node.position]),
      );
      return graph.nodes.map<TurnFlowNode>((turn) => {
        const isMatch = matchingIds.has(turn.id);
        const isPinned = pinnedIds.has(turn.id);
        const invalidParentReason = turn.stale
          ? "过期节点不可选，请先重新生成"
          : disabledParentIds.has(turn.id)
            ? "自身或下游节点不可选"
            : null;
        const canToggleParent =
          !parentActionsDisabled && (isPinned || !invalidParentReason);
        const parentDisabledReason =
          isPinned && invalidParentReason && canToggleParent
            ? turn.stale
              ? "过期父节点，点击移除"
              : "无效父节点，点击移除"
            : invalidParentReason;
        return {
          id: turn.id,
          type: "turn",
          position: positions?.get(turn.id) ??
            currentPositions.get(turn.id) ?? { x: 0, y: 0 },
          width: GRAPH_NODE_WIDTH,
          height: GRAPH_NODE_HEIGHT,
          selected: turn.id === selectedNodeId,
          deletable: false,
          connectable: false,
          selectable: !parentControl.picking,
          ariaRole: parentControl.picking ? "checkbox" : "button",
          ariaLabel: `第 ${turn.sequence} 轮：${turn.question}${parentControl.picking && parentDisabledReason ? `，${parentDisabledReason}` : ""}`,
          domAttributes: parentControl.picking
            ? {
                "aria-checked": isPinned,
                "aria-disabled": !canToggleParent,
              }
            : undefined,
          data: {
            turn,
            isCurrent: turn.id === selectedNodeId,
            isParent: relations.parentIds.has(turn.id),
            isContext: relations.contextIds.has(turn.id),
            isDimmed:
              !isPinned &&
              ((focusMode &&
                !parentControl.picking &&
                Boolean(relations.selected) &&
                !relations.relatedIds.has(turn.id)) ||
                (hasSearch && !isMatch)),
            isSearchMatch: hasSearch && isMatch,
            isPinned,
            picking: parentControl.picking,
            showParentControl: !parentActionsDisabled,
            canToggleParent,
            parentDisabledReason,
            onToggleParent: parentControl.onToggleParent,
          },
        };
      });
    });

    const persistedEdges: Edge[] = graph.edges.map((edge) => {
      const direct =
        edge.target === selectedNodeId && relations.parentIds.has(edge.source);
      const context =
        relations.relatedIds.has(edge.source) &&
        relations.relatedIds.has(edge.target);
      const searchDim =
        hasSearch &&
        (!matchingIds.has(edge.source) || !matchingIds.has(edge.target));
      const dimmed =
        (focusMode &&
          !parentControl.picking &&
          Boolean(relations.selected) &&
          !context) ||
        searchDim;
      const color = direct ? "#b9a1f5" : context ? "#6aa98f" : "#3b4852";
      return {
        id: `${edge.source}:${edge.target}`,
        source: edge.source,
        target: edge.target,
        type: "smoothstep",
        deletable: false,
        focusable: false,
        interactionWidth: 0,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 16,
          height: 16,
        },
        style: {
          stroke: color,
          strokeWidth: direct ? 1.8 : 1.3,
          opacity: dimmed ? 0.13 : 1,
        },
      };
    });
    const target = parentControl.regenerationTarget;
    const eligibleIds = new Set(
      graph.nodes.filter((turn) => !turn.stale).map((turn) => turn.id),
    );
    const previewEdges: Edge[] =
      target && parentControl.mode !== "auto"
        ? [...pinnedIds]
            .filter(
              (id) =>
                eligibleIds.has(id) &&
                id !== target.id &&
                !disabledParentIds.has(id),
            )
            .map((id) => ({
              id: `parent-preview:${id}:${target.id}`,
              source: id,
              target: target.id,
              className: "graph-preview-edge",
              type: "smoothstep",
              selectable: false,
              deletable: false,
              focusable: false,
              interactionWidth: 0,
              data: { preview: true },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: "#d0b1ff",
                width: 16,
                height: 16,
              },
              style: {
                stroke: "#d0b1ff",
                strokeWidth: 2,
                strokeDasharray: "6 5",
                opacity: 0.95,
              },
              zIndex: 2,
            }))
        : [];
    setEdges([...persistedEdges, ...previewEdges]);
  }, [
    graph,
    layoutKey,
    selectedNodeId,
    relations,
    focusMode,
    hasSearch,
    searchQuery,
    setNodes,
    setEdges,
    parentControl,
    parentActionsDisabled,
    disabledParentIds,
    pinnedIds,
  ]);

  useEffect(() => {
    if (!graph.nodes.length) return;
    const timeout = window.setTimeout(handleFit, 70);
    return () => window.clearTimeout(timeout);
  }, [layoutKey, graph.nodes.length, handleFit]);

  useEffect(() => {
    const topologyChanged = previousCenterTopology.current !== topologyKey;
    previousCenterTopology.current = topologyKey;
    if (topologyChanged) {
      lastSelection.current = selectedNodeId;
      graphClick.current = false;
      return;
    }
    if (!selectedNodeId) {
      lastSelection.current = null;
      graphClick.current = false;
      return;
    }
    if (lastSelection.current === selectedNodeId) return;
    lastSelection.current = selectedNodeId;
    if (graphClick.current) {
      graphClick.current = false;
      return;
    }
    const timeout = window.setTimeout(() => {
      const node = getNode(selectedNodeId);
      if (!node) return;
      void setCenter(
        node.position.x + GRAPH_NODE_WIDTH / 2,
        node.position.y + GRAPH_NODE_HEIGHT / 2,
        {
          zoom: Math.max(0.85, Math.min(getZoom(), 1.15)),
          duration: 400,
        },
      );
    }, 110);
    return () => window.clearTimeout(timeout);
  }, [selectedNodeId, topologyKey, getNode, setCenter, getZoom]);

  return (
    <section className="graph-panel" aria-label="对话思路图谱">
      <header className="graph-heading">
        <div>
          <div className="graph-eyebrow">CONVERSATION MAP</div>
          <div className="graph-title-line">
            <h2>思路图谱</h2>
            <span className="graph-live-dot" aria-hidden="true" />
          </div>
        </div>
        <div className="graph-heading-actions">
          <span className="graph-count">
            <strong>{graph.nodes.length}</strong> 节点 <span>·</span>{" "}
            <strong>{graph.edges.length}</strong> 关联
          </span>
          {relations.selected && (
            <button
              className="graph-regenerate-button"
              type="button"
              disabled={parentActionsDisabled}
              onClick={() =>
                parentControl.onStartRegeneration(relations.selected!.id)
              }
              title={`调整第 ${relations.selected.sequence} 轮的父节点，然后重新生成此轮`}
            >
              <RotateCcw size={11} aria-hidden="true" />
              调整父节点并重新生成
            </button>
          )}
        </div>
      </header>

      <div className="graph-toolbar">
        <label className="graph-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="搜索对话节点"
            placeholder="搜索问题与回答…"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          {hasSearch && (
            <button
              className="graph-clear-search"
              type="button"
              aria-label="清除节点搜索"
              onClick={() => onSearchChange("")}
            >
              <X size={13} />
            </button>
          )}
        </label>
        <button
          className={`graph-focus-button${focusMode ? " is-active" : ""}`}
          type="button"
          onClick={onToggleFocus}
          aria-pressed={focusMode}
          title="突出当前节点、父节点与实际使用的上下文"
        >
          <Focus size={14} aria-hidden="true" />
          <span>聚焦上下文</span>
        </button>
      </div>

      <div
        className={`graph-parent-controls${parentControl.picking ? " is-picking" : ""}`}
      >
        <div className="graph-parent-control-main">
          <label className="graph-parent-mode">
            <GitBranch size={12} aria-hidden="true" />
            <select
              aria-label="图谱父节点选择模式"
              value={parentControl.mode}
              disabled={parentActionsDisabled}
              onChange={(event) =>
                parentControl.onModeChange(event.target.value as ParentMode)
              }
            >
              <option value="auto">自动识别</option>
              <option value="augment">自动 + 指定</option>
              <option value="manual">仅用指定</option>
            </select>
          </label>
          <span className="graph-pinned-count">
            已选 <strong>{parentControl.selectedIds.length}</strong>
          </span>
          <button
            type="button"
            className="graph-pick-button"
            disabled={parentActionsDisabled || graph.nodes.length === 0}
            aria-pressed={parentControl.picking}
            onClick={parentControl.onTogglePicking}
          >
            {parentControl.picking ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <Plus size={12} aria-hidden="true" />
            )}
            {parentControl.picking ? "完成选择" : "从图谱选父节点"}
          </button>
        </div>
        {parentControl.regenerationTarget ? (
          <div className="graph-parent-hint graph-regeneration-hint">
            <span title={parentControl.regenerationTarget.question}>
              正在调整第 {parentControl.regenerationTarget.sequence} 轮 ·{" "}
              {parentControl.picking
                ? "点击节点添加或移除父节点"
                : "虚线为待应用的父节点关联"}
            </span>
            <button
              type="button"
              disabled={parentActionsDisabled}
              onClick={parentControl.onCancelRegeneration}
              aria-label="取消图谱重新生成"
            >
              <X size={12} />
            </button>
          </div>
        ) : parentControl.picking ? (
          <p className="graph-parent-hint">
            点击节点添加或移除父节点；完成后发送新问题。
          </p>
        ) : null}
      </div>

      <div
        className="graph-canvas"
        ref={canvasRef}
        data-testid="graph-canvas"
        onKeyDownCapture={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const element = event.target instanceof Element ? event.target : null;
          if (element?.closest("button")) return;
          const id = element
            ?.closest(".react-flow__node")
            ?.getAttribute("data-id");
          if (!id) return;
          event.preventDefault();
          event.stopPropagation();
          activateNode(id);
        }}
      >
        <ReactFlow<TurnFlowNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => activateNode(node.id)}
          nodesDraggable={!parentControl.picking}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          selectionOnDrag={false}
          panOnScroll
          minZoom={0.15}
          maxZoom={1.6}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
          attributionPosition="bottom-left"
          colorMode="dark"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="#334047"
          />
        </ReactFlow>

        {graph.nodes.length === 0 && (
          <div className="graph-empty">
            <div className="graph-empty-symbol">
              <Workflow size={30} strokeWidth={1.2} aria-hidden="true" />
            </div>
            <h3>让思路，自然连接</h3>
            <p>
              发送第一个问题，从这里开始。
              <br />
              后续问题可自动关联，也可以从图中指定父节点。
            </p>
            <span>每一个分支，都有迹可循</span>
          </div>
        )}

        {hasSearch && (
          <div className="graph-search-result" role="status">
            {matchedCount
              ? `找到 ${matchedCount} 个相关节点`
              : "没有匹配的节点"}
          </div>
        )}

        {!parentControl.regenerationTarget &&
          parentControl.selectedIds.length > 0 && (
            <div className="graph-next-context" role="status">
              <GitBranch size={12} aria-hidden="true" />
              <span>
                下一轮 · {parentModeLabel} · {parentControl.selectedIds.length}{" "}
                个指定父节点
              </span>
            </div>
          )}

        {graph.nodes.length > 0 && (
          <div className="graph-navigation" aria-label="图谱视图控制">
            <button
              type="button"
              aria-label="放大图谱"
              title="放大"
              onClick={() => void zoomIn({ duration: 180 })}
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              aria-label="缩小图谱"
              title="缩小"
              onClick={() => void zoomOut({ duration: 180 })}
            >
              <Minus size={15} />
            </button>
            <span />
            <button
              type="button"
              aria-label="显示完整图谱"
              title="显示完整图谱"
              onClick={handleFit}
            >
              <Maximize2 size={14} />
            </button>
            <button
              type="button"
              aria-label="重新自动排列节点"
              title="重新排列"
              onClick={() => setLayoutRevision((value) => value + 1)}
            >
              <LayoutGrid size={14} />
            </button>
          </div>
        )}
      </div>

      <footer className="graph-footer">
        <div className="graph-legend">
          <span>
            <i className="graph-key graph-key--current" />
            当前节点
          </span>
          <span>
            <i className="graph-key graph-key--parent" />
            父节点
          </span>
          <span>
            <i className="graph-key graph-key--context" />
            已用上下文
          </span>
          {parentControl.selectedIds.length > 0 && (
            <span>
              <i className="graph-key graph-key--pinned" />
              指定父节点
            </span>
          )}
        </div>
        <span className="graph-footer-hint">
          {parentControl.picking
            ? "点击或按空格选择父节点"
            : "拖动画布 · 点击定位对话"}
        </span>
      </footer>
    </section>
  );
}

export function GraphPanel(props: GraphPanelProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
