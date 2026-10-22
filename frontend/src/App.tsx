import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Compass,
  ExternalLink,
  GitBranch,
  LayoutPanelLeft,
  LoaderCircle,
  Menu,
  MessageSquare,
  Network,
  Plus,
  RefreshCw,
  Sparkles,
  Waypoints,
  X,
} from "lucide-react";
import { api } from "./api";
import { DEMO_ID, demoGraph, emptyGraph } from "./demo";
import { GraphPanel } from "./components/GraphPanel";
import { ConversationPanel } from "./components/ConversationPanel";
import { getDescendantIds } from "./graph";
import type {
  Conversation,
  ConversationGraph,
  Health,
  ParentControls,
  ParentMode,
  ParentRequest,
  TurnNode,
} from "./types";

type View = "split" | "graph" | "chat";
const STORAGE_KEY = "lattice.workspace.v1";
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "发生了未知错误，请重试。";

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Browsing remains usable when storage is unavailable. */
  }
}

function displayTitle(conversation: Conversation) {
  return conversation.title === "Untitled conversation"
    ? "未命名对话"
    : conversation.title;
}

export default function App() {
  const [graph, setGraph] = useState<ConversationGraph>(demoGraph);
  const [activeId, setActiveId] = useState<string | null>(DEMO_ID);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("demo-6");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [connection, setConnection] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>("split");
  const [focusMode, setFocusMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exported, setExported] = useState(false);
  const [parentMode, setParentMode] = useState<ParentMode>("auto");
  const [parentIds, setParentIds] = useState<string[]>([]);
  const [pickingParents, setPickingParents] = useState(false);
  const [regenerationTarget, setRegenerationTarget] = useState<TurnNode | null>(
    null,
  );
  const parentDraftBeforeEdit = useRef<{
    mode: ParentMode;
    ids: string[];
  } | null>(null);
  const navigationVersion = useRef(0);
  const sending = useRef(false);
  const helpDialogRef = useRef<HTMLDivElement>(null);
  const isDemo = activeId === DEMO_ID;
  const draftKey = activeId ?? "new";
  const draft = drafts[draftKey] ?? "";
  const disabledParentIds = new Set(
    graph.nodes.filter((node) => node.stale).map((node) => node.id),
  );
  if (regenerationTarget) {
    disabledParentIds.add(regenerationTarget.id);
    getDescendantIds(graph, regenerationTarget.id).forEach((id) =>
      disabledParentIds.add(id),
    );
  }

  function resetParentControls() {
    setParentMode("auto");
    setParentIds([]);
    setPickingParents(false);
    setRegenerationTarget(null);
    parentDraftBeforeEdit.current = null;
  }

  function revealGraph() {
    if (window.matchMedia("(max-width: 640px)").matches) setView("graph");
    else setView((current) => (current === "chat" ? "split" : current));
  }

  function changeParentMode(mode: ParentMode) {
    if (sending.current || loading || isDemo) return;
    setParentMode(mode);
    if (mode === "auto") {
      setParentIds([]);
      setPickingParents(false);
      if (pickingParents) {
        if (window.matchMedia("(max-width: 640px)").matches) setView("chat");
        else setView((current) => (current === "graph" ? "split" : current));
      }
    }
  }

  function togglePicking() {
    if (sending.current || loading || isDemo) return;
    const next = !pickingParents;
    setPickingParents(next);
    if (next) {
      if (parentMode === "auto") setParentMode("augment");
      revealGraph();
    } else if (window.matchMedia("(max-width: 640px)").matches) setView("chat");
    else setView((current) => (current === "graph" ? "split" : current));
  }

  function toggleParent(id: string) {
    if (sending.current || loading || isDemo) return;
    // Already-selected invalid parents can still be removed after an upstream edit.
    if (parentIds.includes(id)) {
      setParentIds((current) => current.filter((value) => value !== id));
      return;
    }
    if (
      disabledParentIds.has(id) ||
      !graph.nodes.some((node) => node.id === id)
    )
      return;
    if (parentIds.length >= 64) {
      setError("最多指定 64 个直接父节点，请先移除部分选择。");
      return;
    }
    if (parentMode === "auto") setParentMode("augment");
    setParentIds((current) =>
      current.includes(id) ? current : [...current, id],
    );
  }

  function startRegeneration(id: string) {
    if (sending.current || loading || isDemo) return;
    const target = graph.nodes.find((node) => node.id === id);
    if (!target) return;
    if (!regenerationTarget)
      parentDraftBeforeEdit.current = { mode: parentMode, ids: parentIds };
    setRegenerationTarget(target);
    setSelectedNodeId(id);
    setParentMode("manual");
    setParentIds([...target.parent_ids]);
    setPickingParents(true);
    setSearchQuery("");
    setError(null);
    revealGraph();
  }

  function cancelRegeneration() {
    if (sending.current || loading) return;
    const original = parentDraftBeforeEdit.current;
    setRegenerationTarget(null);
    setParentMode(original?.mode ?? "auto");
    setParentIds(original?.ids ?? []);
    setPickingParents(false);
    parentDraftBeforeEdit.current = null;
    if (window.matchMedia("(max-width: 640px)").matches) setView("chat");
    else setView((current) => (current === "graph" ? "split" : current));
  }

  const parentControl: ParentControls = {
    mode: parentMode,
    selectedIds: parentIds,
    picking: pickingParents,
    disabledIds: [...disabledParentIds],
    regenerationTarget,
    busy: pending || loading,
    readOnly: isDemo,
    onModeChange: changeParentMode,
    onTogglePicking: togglePicking,
    onToggleParent: toggleParent,
    onClear: () => {
      if (!sending.current && !loading) setParentIds([]);
    },
    onCancelRegeneration: cancelRegeneration,
    onStartRegeneration: startRegeneration,
  };

  async function checkBackend() {
    setConnection("checking");
    const [status, history] = await Promise.allSettled([
      api.health(),
      api.conversations(),
    ]);
    if (status.status === "fulfilled") {
      setHealth(status.value);
      setConnection("online");
    } else {
      setHealth(null);
      setConnection("offline");
    }
    if (history.status === "fulfilled") setConversations(history.value);
    else if (status.status === "fulfilled")
      setError("服务已连接，但未能读取会话列表，请刷新重试。");
  }

  useEffect(() => {
    void checkBackend();
    let restored: string | null = null;
    try {
      restored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* Optional preference. */
    }
    if (!restored || restored === DEMO_ID) return;
    const version = ++navigationVersion.current;
    setLoading(true);
    api
      .graph(restored)
      .then((result) => {
        if (version !== navigationVersion.current) return;
        setGraph(result);
        setActiveId(result.conversation.id);
        setSelectedNodeId(result.nodes.at(-1)?.id ?? null);
      })
      .catch((cause: unknown) => {
        if (version !== navigationVersion.current) return;
        setError(`未能恢复上次的会话：${errorMessage(cause)}`);
      })
      .finally(() => {
        if (version === navigationVersion.current) setLoading(false);
      });
    return () => {
      navigationVersion.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!helpOpen) return;
    const previousFocus = document.activeElement;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelpOpen(false);
      if (event.key !== "Tab") return;
      const focusable = helpDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input, textarea, [tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [helpOpen]);

  async function openConversation(id: string) {
    if (sending.current) return;
    setSidebarOpen(false);
    setError(null);
    setSearchQuery("");
    resetParentControls();
    const version = ++navigationVersion.current;
    if (id === DEMO_ID) {
      setLoading(false);
      setActiveId(DEMO_ID);
      setGraph(demoGraph);
      setSelectedNodeId("demo-6");
      remember(DEMO_ID);
      return;
    }
    setLoading(true);
    try {
      const result = await api.graph(id);
      if (version !== navigationVersion.current) return;
      setGraph(result);
      setActiveId(id);
      setSelectedNodeId(result.nodes.at(-1)?.id ?? null);
      remember(id);
    } catch (cause) {
      if (version === navigationVersion.current) setError(errorMessage(cause));
    } finally {
      if (version === navigationVersion.current) setLoading(false);
    }
  }

  function newConversation() {
    if (sending.current) return;
    navigationVersion.current += 1;
    setLoading(false);
    setActiveId(null);
    setGraph(emptyGraph());
    setSelectedNodeId(null);
    setSearchQuery("");
    setFocusMode(false);
    setSidebarOpen(false);
    setError(null);
    resetParentControls();
    remember(null);
  }

  async function send(question: string) {
    if (sending.current || loading || isDemo || !question.trim()) return;
    if (
      parentMode !== "auto" &&
      parentIds.some((id) => disabledParentIds.has(id))
    ) {
      setError("选择中包含已过期或会形成环的父节点，请移除或先更新上游节点。");
      return;
    }
    const parents: ParentRequest = {
      parent_mode: parentMode,
      parent_ids: parentMode === "auto" ? [] : [...parentIds],
    };
    sending.current = true;
    setPending(true);
    setError(null);
    let id = activeId;
    let workingGraph = graph;
    const submittedDraftKey = draftKey;
    try {
      if (regenerationTarget) {
        const result = await api.regenerate(
          regenerationTarget.id,
          parents,
          regenerationTarget.revision ?? 1,
        );
        setGraph(result);
        setSelectedNodeId(regenerationTarget.id);
        resetParentControls();
        setSearchQuery("");
        void checkBackend();
        return;
      }
      if (!id) {
        const conversation = await api.createConversation(
          question.trim().slice(0, 64),
        );
        id = conversation.id;
        workingGraph = { conversation, nodes: [], edges: [] };
        setActiveId(id);
        setGraph(workingGraph);
        // Keep the question recoverable if the model fails after creating a conversation.
        setDrafts((current) => ({ ...current, [id!]: question }));
        setConversations((current) => [conversation, ...current]);
        remember(id);
      }
      const node = await api.send(
        id,
        question.trim(),
        parentMode === "auto" ? undefined : parents,
      );
      const committedGraph: ConversationGraph = {
        ...workingGraph,
        nodes: [...workingGraph.nodes, node],
        edges: [
          ...workingGraph.edges,
          ...node.parent_ids.map((source) => ({
            source,
            target: node.id,
            kind: "depends_on" as const,
          })),
        ],
      };
      setGraph(committedGraph);
      setSelectedNodeId(node.id);
      setSearchQuery("");
      setDrafts((current) => ({
        ...current,
        [submittedDraftKey]: "",
        [id!]: "",
      }));
      resetParentControls();
      setConnection("online");
      // Read the authoritative graph to include turns committed from another tab.
      try {
        setGraph(await api.graph(id));
      } catch {
        setError(
          "本轮已保存，但图谱同步失败。可点击刷新重新读取；无需再次发送。",
        );
      }
      void checkBackend();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  function selectNode(id: string) {
    setSelectedNodeId(id);
  }

  function exportGraph() {
    const blob = new Blob([JSON.stringify(graph, null, 2)], {
      type: "application/json",
    });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `lattice-${isDemo ? "demo" : (activeId ?? "new")}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
    setExported(true);
    window.setTimeout(() => setExported(false), 1800);
  }

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭侧栏"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`sidebar ${sidebarOpen ? "is-open" : ""}`}
        aria-label="会话导航"
      >
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            void openConversation(DEMO_ID);
          }}
        >
          <span className="brand-mark">
            <Waypoints size={23} strokeWidth={1.7} />
          </span>
          <span>
            LATTICE<span className="brand-version">RESEARCH PREVIEW</span>
          </span>
        </a>
        <button
          className="new-conversation"
          onClick={newConversation}
          disabled={pending}
        >
          <Plus size={17} />
          <span>新建对话</span>
          <span className="new-arrow">
            <ArrowRight size={15} />
          </span>
        </button>
        <div className="nav-section-label">
          工作空间<span>{conversations.length + 1}</span>
        </div>
        <div className="conversation-list">
          <button
            className={`conversation-nav demo-nav ${isDemo ? "is-active" : ""}`}
            disabled={pending}
            onClick={() => void openConversation(DEMO_ID)}
          >
            <Compass size={17} />
            <span>
              <strong>重新想象 AI 对话</strong>
              <small>交互示例 · 只读</small>
            </span>
            {isDemo && <span className="active-dot" />}
          </button>
          {conversations.length > 0 && (
            <div className="nav-sub-label">你的对话</div>
          )}
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={`conversation-nav ${activeId === conversation.id ? "is-active" : ""}`}
              title={displayTitle(conversation)}
              disabled={pending}
              onClick={() => void openConversation(conversation.id)}
            >
              <MessageSquare size={16} />
              <span>
                <strong>{displayTitle(conversation)}</strong>
                <small>
                  {new Date(conversation.created_at).toLocaleDateString(
                    "zh-CN",
                    { month: "short", day: "numeric" },
                  )}
                </small>
              </span>
              {activeId === conversation.id && <span className="active-dot" />}
            </button>
          ))}
          {conversations.length === 0 && (
            <p className="history-empty">
              从一个问题开始，
              <br />
              让思路在这里生长。
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <GitBranch size={18} />
            <p>
              思路可以分叉，
              <br />
              <strong>也可以重新相遇。</strong>
            </p>
          </div>
          <button className="help-link" onClick={() => setHelpOpen(true)}>
            <CircleHelp size={16} />
            工作台使用指南
            <ChevronRight size={14} />
          </button>
          <div className="sidebar-footer">
            <span className="avatar">L</span>
            <span>
              本地研究工作台<small>Topology-informed conversations</small>
            </span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="workspace-header">
          <button
            className="icon-button menu-toggle"
            aria-label="打开会话导航"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{displayTitle(graph.conversation)}</strong>
            {isDemo && <span className="demo-badge">DEMO</span>}
          </div>
          <div className="header-actions">
            <span
              className={`connection-status ${connection}`}
              title={
                health
                  ? `回答模型：${health.answer_provider} · 路由：${health.routing_strategy}`
                  : "启动后端后点击刷新连接"
              }
            >
              <span />
              {connection === "checking"
                ? "连接中"
                : connection === "offline"
                  ? "后端未连接"
                  : health?.answer_provider === "mock"
                    ? "MOCK · 已连接"
                    : "后端已连接"}
            </span>
            <button
              className="icon-button"
              aria-label="刷新后端与当前对话"
              title="刷新"
              disabled={pending || loading}
              onClick={() => {
                void checkBackend();
                if (activeId && !isDemo) void openConversation(activeId);
              }}
            >
              <RefreshCw size={16} className={loading ? "spin" : ""} />
            </button>
            <a
              className="icon-button api-docs"
              href="/docs"
              target="_blank"
              rel="noreferrer"
              aria-label="打开后端 API 文档"
              title="API 文档"
            >
              <ExternalLink size={15} />
            </a>
          </div>
        </header>

        <div className="workspace-intro">
          <div>
            <div className="eyebrow">
              <span /> A SPACE FOR CONNECTED THINKING
            </div>
            <h1>
              让每一个想法，<span>有迹可循。</span>
            </h1>
            <p>自然地提问，自动地连接。沿着思路，回到任何一个起点。</p>
          </div>
          <div className="intro-actions">
            <span className="auto-link-badge">
              <Sparkles size={14} />
              自动 / 指定父节点
            </span>
            <button
              className="export-button"
              onClick={exportGraph}
              disabled={loading}
              title="导出完整问答、依赖关系和上下文 JSON"
            >
              {exported ? <Check size={15} /> : <ArrowDownToLine size={15} />}
              {exported ? "已导出" : "导出图谱"}
            </button>
          </div>
        </div>

        <div className="workspace-toolbar">
          <div className="workspace-caption">
            <Network size={15} />
            <span>
              {isDemo
                ? "从分支探索，到多路思考的交汇"
                : graph.nodes.length
                  ? `${graph.nodes.length} 轮对话，思路持续生长`
                  : "你的下一次探索，从这里开始"}
            </span>
          </div>
          <div className="view-switch" aria-label="工作区视图">
            {(
              [
                ["split", LayoutPanelLeft, "双栏"],
                ["graph", Network, "图谱"],
                ["chat", MessageSquare, "对话"],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                className={view === value ? "is-active" : ""}
                aria-pressed={view === value}
                onClick={() => setView(value)}
              >
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => setError(null)}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {connection === "offline" && !error && (
          <div className="offline-banner">
            后端暂未连接。可先浏览示例；启动服务后点击右上角刷新。
          </div>
        )}
        {!isDemo && health?.answer_provider === "mock" && (
          <div className="mock-banner">
            <Sparkles size={13} />
            当前为离线
            MOCK：可以验证自动连线和上下文流程；真实回答需要在后端配置模型。
          </div>
        )}

        <main
          className="workspace-content"
          data-view={view}
          aria-busy={loading}
        >
          <GraphPanel
            graph={graph}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            focusMode={focusMode}
            onToggleFocus={() => setFocusMode((value) => !value)}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            parentControl={parentControl}
          />
          <ConversationPanel
            graph={graph}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            onSend={send}
            pending={pending}
            disabled={loading}
            isDemo={isDemo}
            provider={health?.answer_provider ?? null}
            draft={draft}
            parentControl={parentControl}
            onDraftChange={(value) =>
              setDrafts((current) => ({ ...current, [draftKey]: value }))
            }
          />
          {loading && (
            <div className="loading-overlay" role="status">
              <LoaderCircle size={22} className="spin" />
              <span>正在读取对话图谱…</span>
            </div>
          )}
        </main>
        <footer className="workspace-footer">
          <span>
            <span className="footer-dot" /> LATTICE / RESEARCH WORKSPACE
          </span>
          <span>
            {isDemo
              ? "示例问答与连线为预置数据，未调用模型"
              : "问答版本持久保存 · 父节点自动或指定"}
          </span>
        </footer>
      </div>

      {helpOpen && (
        <div className="dialog-backdrop" onClick={() => setHelpOpen(false)}>
          <div
            className="help-dialog"
            ref={helpDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button dialog-close"
              aria-label="关闭使用指南"
              autoFocus
              onClick={() => setHelpOpen(false)}
            >
              <X size={19} />
            </button>
            <span className="dialog-mark">
              <Waypoints size={28} />
            </span>
            <div className="eyebrow">THINK IN CONNECTIONS</div>
            <h2 id="help-title">探索你的思路网络</h2>
            <p>
              每轮问答都是一个节点。你可以让系统自动关联，也可以从图中指定父节点，控制本轮上下文。
            </p>
            <ol>
              <li>
                <strong>开始对话</strong>
                <span>新建对话后自然提问，系统会自动生成节点与连线。</span>
              </li>
              <li>
                <strong>沿图浏览</strong>
                <span>
                  点击节点定位问答，拖动画布或使用滚轮缩放。开启“从图中选择”后，点击节点即可勾选父节点。
                </span>
              </li>
              <li>
                <strong>指定与重新生成</strong>
                <span>
                  选择“自动 +
                  指定”保留自动关联，或用“仅指定”锁定直接父节点。选中已有节点后，可调整父节点并重新生成；旧回答保存在历史版本中，下游节点会提示需要重新生成。
                </span>
              </li>
              <li>
                <strong>检查上下文</strong>
                <span>
                  切换到上下文检查，查看父节点选择依据、实际使用的原文或摘要，以及输入预算估算。
                </span>
              </li>
            </ol>
            <p className="help-footnote">
              示例空间使用预置数据。默认后端为
              MOCK；模型地址与密钥在后端配置，不在浏览器内设置。
            </p>
            <button
              className="new-conversation"
              onClick={() => setHelpOpen(false)}
            >
              开始探索
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
