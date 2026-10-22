import {
  memo,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  CornerDownLeft,
  GitBranch,
  History,
  Layers3,
  MessageSquare,
  ScanLine,
  Sparkles,
  RotateCcw,
  MousePointer2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type {
  ConversationGraph,
  ParentControls,
  ParentMode,
  TurnNode,
} from "../types";
import "./conversation.css";

interface ConversationPanelProps {
  graph: ConversationGraph;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onSend: (question: string) => Promise<void>;
  pending: boolean;
  disabled: boolean;
  isDemo: boolean;
  provider: string | null;
  draft: string;
  onDraftChange: (value: string) => void;
  parentControl: ParentControls;
}

const suggestions = [
  "帮我梳理一下这个研究想法",
  "这个方案有哪些值得探索的方向？",
  "我们先从一个简单的例子开始",
];
const number = (value: number) => value.toLocaleString("zh-CN");
const turnLabel = (node: TurnNode) => String(node.sequence).padStart(2, "0");
const parentModes: { mode: ParentMode; label: string }[] = [
  { mode: "auto", label: "自动判断" },
  { mode: "augment", label: "自动 + 指定" },
  { mode: "manual", label: "仅指定" },
];
const modeLabel = (mode?: ParentMode) =>
  parentModes.find((item) => item.mode === (mode ?? "auto"))?.label ?? mode;

interface VersionHistoryState {
  key: string;
  items: TurnNode[] | null;
  loading: boolean;
  error: string | null;
}

// Draft updates should not reparse every historical Markdown response.
const AnswerMarkdown = memo(function AnswerMarkdown({
  answer,
}: {
  answer: string;
}) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {answer}
      </ReactMarkdown>
    </div>
  );
});

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "instant"
    : "smooth";
}

export function ConversationPanel({
  graph,
  selectedNodeId,
  onSelectNode,
  onSend,
  pending,
  disabled,
  isDemo,
  provider,
  draft,
  onDraftChange,
  parentControl,
}: ConversationPanelProps) {
  const [tab, setTab] = useState<"conversation" | "context">("conversation");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyErrorId, setCopyErrorId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationTabRef = useRef<HTMLButtonElement>(null);
  const contextTabRef = useRef<HTMLButtonElement>(null);
  const turnRefs = useRef(new Map<string, HTMLElement>());
  const previousCount = useRef(graph.nodes.length);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composingRef = useRef(false);
  const selectedNode =
    graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const controlsDisabled =
    pending ||
    disabled ||
    isDemo ||
    parentControl.readOnly ||
    parentControl.busy;
  const regenerationTarget = parentControl.regenerationTarget;
  const composerQuestion = regenerationTarget?.question ?? draft;
  const selectedRevision = selectedNode?.revision ?? 1;
  const historyKey = `${graph.conversation.id}:${selectedNodeId ?? ""}:${selectedRevision}`;
  const activeHistoryKey = useRef(historyKey);
  activeHistoryKey.current = historyKey;
  const historyRequest = useRef(0);
  const [history, setHistory] = useState<VersionHistoryState>({
    key: historyKey,
    items: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    historyRequest.current += 1;
    setHistory({ key: historyKey, items: null, loading: false, error: null });
    return () => {
      historyRequest.current += 1;
    };
  }, [historyKey]);

  useEffect(() => {
    if (tab !== "conversation" || !selectedNodeId) return;
    const container = scrollRef.current;
    const element = turnRefs.current.get(selectedNodeId);
    if (!container || !element) return;
    // Only scroll the conversation viewport; scrollIntoView can also move the page.
    const top =
      container.scrollTop +
      element.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      18;
    container.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
  }, [selectedNodeId, selectedRevision, tab, graph.conversation.id]);

  useEffect(() => {
    if (graph.nodes.length > previousCount.current && tab === "conversation") {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: scrollBehavior(),
      });
    }
    previousCount.current = graph.nodes.length;
  }, [graph.nodes.length, tab]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [composerQuestion]);

  useEffect(
    () => () => {
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
    },
    [],
  );

  async function copyAnswer(node: TurnNode) {
    try {
      await navigator.clipboard.writeText(node.answer);
      setCopyErrorId(null);
      setCopiedId(node.id);
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setCopyErrorId(node.id);
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!composerQuestion.trim() || controlsDisabled || composingRef.current)
      return;
    try {
      await onSend(
        regenerationTarget ? regenerationTarget.question : draft.trim(),
      );
    } catch {
      // The application owns request errors and preserves the draft for retry.
    }
  }

  async function loadVersions() {
    if (!selectedNode || isDemo || parentControl.readOnly) return;
    const key = historyKey;
    const request = ++historyRequest.current;
    setHistory({ key, items: null, loading: true, error: null });
    try {
      const items = await api.versions(selectedNode.id);
      if (
        historyRequest.current !== request ||
        activeHistoryKey.current !== key
      )
        return;
      setHistory({ key, items, loading: false, error: null });
    } catch (error) {
      if (
        historyRequest.current !== request ||
        activeHistoryKey.current !== key
      )
        return;
      setHistory({
        key,
        items: null,
        loading: false,
        error:
          error instanceof Error ? error.message : "历史版本加载失败，请重试。",
      });
    }
  }

  function startRegeneration(id: string) {
    if (controlsDisabled) return;
    parentControl.onStartRegeneration(id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !composingRef.current &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      void submit();
    }
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let nextTab: typeof tab;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft")
      nextTab = tab === "conversation" ? "context" : "conversation";
    else if (event.key === "Home") nextTab = "conversation";
    else if (event.key === "End") nextTab = "context";
    else return;
    event.preventDefault();
    setTab(nextTab);
    (nextTab === "conversation"
      ? conversationTabRef
      : contextTabRef
    ).current?.focus();
  }

  function parentChip(id: string, key?: string) {
    const node = nodeMap.get(id);
    return (
      <button
        type="button"
        className="chat-parent-chip"
        key={key ?? id}
        onClick={() => onSelectNode(id)}
        title={node?.question ?? id}
        aria-label={
          node
            ? `浏览父节点 ${turnLabel(node)}：${node.question}`
            : `浏览节点 ${id}`
        }
        disabled={!node}
      >
        <GitBranch size={11} aria-hidden="true" />
        {node ? `#${turnLabel(node)}` : id.slice(0, 8)}
      </button>
    );
  }

  return (
    <section className="chat-panel" aria-label="对话与上下文">
      <header className="chat-panel-header">
        <div
          className="chat-tabs"
          role="tablist"
          aria-label="对话面板视图"
          onKeyDown={handleTabKeyDown}
        >
          <button
            type="button"
            ref={conversationTabRef}
            id="chat-conversation-tab"
            role="tab"
            aria-selected={tab === "conversation"}
            aria-controls="chat-conversation-view"
            tabIndex={tab === "conversation" ? 0 : -1}
            className={`chat-tab ${tab === "conversation" ? "is-active" : ""}`}
            onClick={() => setTab("conversation")}
          >
            <MessageSquare size={15} aria-hidden="true" />
            对话
          </button>
          <button
            type="button"
            ref={contextTabRef}
            id="chat-context-tab"
            role="tab"
            aria-selected={tab === "context"}
            aria-controls="chat-context-view"
            tabIndex={tab === "context" ? 0 : -1}
            className={`chat-tab ${tab === "context" ? "is-active" : ""}`}
            onClick={() => setTab("context")}
          >
            <ScanLine size={15} aria-hidden="true" />
            上下文检查
          </button>
        </div>
        <span className="chat-header-counter">
          {String(graph.nodes.length).padStart(2, "0")} <span>TURNS</span>
        </span>
      </header>

      {tab === "conversation" ? (
        <div
          className="chat-scroll"
          ref={scrollRef}
          id="chat-conversation-view"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby="chat-conversation-tab"
          data-testid="conversation-history"
        >
          {isDemo && (
            <div className="chat-demo-banner">
              <Sparkles size={14} aria-hidden="true" />
              <span>
                示例对话 · 点击节点探索分支，新建对话后可连接后端提问。
              </span>
            </div>
          )}
          {graph.nodes.length === 0 ? (
            <div className="chat-empty">
              <div className="chat-empty-symbol">
                <Layers3 size={30} strokeWidth={1.2} aria-hidden="true" />
              </div>
              <span className="chat-eyebrow">
                A SPACE FOR CONNECTED THOUGHTS
              </span>
              <h2>让想法，自由生长。</h2>
              <p>
                从一个问题开始。LATTICE 会自动连接相关的历史，
                <br />
                为每次追问找到它的上下文。
              </p>
              <div className="chat-suggestions">
                {suggestions.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion}
                    disabled={pending || disabled || isDemo}
                    onClick={() => {
                      onDraftChange(suggestion);
                      textareaRef.current?.focus();
                    }}
                  >
                    <span>{suggestion}</span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-turns">
              {graph.nodes.map((node) => (
                <article
                  key={node.id}
                  ref={(element) => {
                    if (element) turnRefs.current.set(node.id, element);
                    else turnRefs.current.delete(node.id);
                  }}
                  className={`chat-turn ${selectedNodeId === node.id ? "is-selected" : ""}`}
                  data-testid={`turn-${node.sequence}`}
                  data-node-id={node.id}
                >
                  <div className="chat-turn-label">
                    <button
                      type="button"
                      className="chat-turn-number"
                      onClick={() => onSelectNode(node.id)}
                      aria-label={`在图中定位节点 ${turnLabel(node)}`}
                      aria-pressed={selectedNodeId === node.id}
                    >
                      {turnLabel(node)}
                    </button>
                    <span>YOU</span>
                    {(node.revision ?? 1) > 1 && (
                      <span className="chat-revision-badge">
                        v{node.revision}
                      </span>
                    )}
                    <span className="chat-turn-line" />
                  </div>
                  <button
                    type="button"
                    className="chat-question"
                    onClick={() => onSelectNode(node.id)}
                  >
                    {node.question}
                  </button>
                  {node.stale && (
                    <div className="chat-stale-notice" role="status">
                      <AlertTriangle size={13} aria-hidden="true" />
                      <div>
                        <strong>上游已更新，需重新生成</strong>
                        {node.stale_reason && <p>{node.stale_reason}</p>}
                      </div>
                    </div>
                  )}
                  <div className="chat-answer-label">
                    <span className="chat-answer-icon">
                      <Layers3 size={13} aria-hidden="true" />
                    </span>
                    <span>LATTICE</span>
                    <span className="chat-answer-rule" />
                    {selectedNodeId === node.id && (
                      <span className="chat-current-label">当前节点</span>
                    )}
                  </div>
                  <AnswerMarkdown answer={node.answer} />
                  <div className="chat-turn-footer">
                    <div className="chat-parents">
                      <span className="chat-parent-caption">
                        <GitBranch size={12} aria-hidden="true" />
                        {node.parent_ids.length ? "上下文来自" : "独立话题"}
                      </span>
                      {node.parent_ids.map((id) => parentChip(id))}
                    </div>
                    <div className="chat-answer-actions">
                      <button
                        type="button"
                        className="chat-regenerate"
                        onClick={() => startRegeneration(node.id)}
                        disabled={controlsDisabled}
                        title="调整父节点并重新生成"
                      >
                        <RotateCcw size={12} aria-hidden="true" />
                        <span>调整父节点并重新生成</span>
                      </button>
                      <button
                        type="button"
                        className="chat-copy"
                        onClick={() => void copyAnswer(node)}
                        title="复制回答"
                        aria-label={
                          copiedId === node.id ? "已复制回答" : "复制回答"
                        }
                      >
                        {copiedId === node.id ? (
                          <Check size={13} aria-hidden="true" />
                        ) : (
                          <Copy size={13} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                  {copyErrorId === node.id && (
                    <p className="chat-copy-error" role="status">
                      复制失败，请手动选择回答文字复制。
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
          {pending && (
            <div className="chat-pending" role="status">
              <span className="chat-pending-dot" />
              正在处理问题并生成回答…
            </div>
          )}
          <div className="chat-history-end" />
        </div>
      ) : (
        <div
          className="context-scroll"
          id="chat-context-view"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby="chat-context-tab"
          data-testid="context-inspector"
        >
          {selectedNode ? (
            <>
              <div className="context-intro">
                <span className="chat-eyebrow">CONTEXT OBSERVABILITY</span>
                {isDemo && (
                  <p className="context-demo-note">
                    示例上下文：以下为预置的关联和内容，未发送给模型。
                  </p>
                )}
                <h2>每次回答，都有迹可循。</h2>
                <p>
                  检查节点 #{turnLabel(selectedNode)} · v{selectedRevision}{" "}
                  实际保存的父节点判断和输入上下文。
                </p>
                <button
                  type="button"
                  className="context-regenerate"
                  disabled={controlsDisabled}
                  onClick={() => startRegeneration(selectedNode.id)}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  调整父节点并重新生成
                </button>
              </div>
              {selectedNode.stale && (
                <div
                  className="chat-stale-notice context-stale-notice"
                  role="status"
                >
                  <AlertTriangle size={14} aria-hidden="true" />
                  <div>
                    <strong>上游已更新，需重新生成</strong>
                    {selectedNode.stale_reason && (
                      <p>{selectedNode.stale_reason}</p>
                    )}
                    <p>
                      以下仍为此回答生成时保存的旧上下文，未自动替换为上游的新内容。
                    </p>
                  </div>
                </div>
              )}
              <section className="context-card">
                <div className="context-section-title">
                  <GitBranch size={15} aria-hidden="true" />
                  <h3>父节点选择记录</h3>
                  <span className="context-strategy">
                    {selectedNode.selection.strategy}
                  </span>
                </div>
                <p className="context-selected-question">
                  {selectedNode.question}
                </p>
                <div className="context-parent-row context-requested-row">
                  <span>选择模式</span>
                  <div>
                    <span className="context-mode-badge">
                      {modeLabel(selectedNode.selection.mode)}
                    </span>
                  </div>
                </div>
                <div className="context-parent-row context-requested-row">
                  <span>请求中指定</span>
                  <div>
                    {selectedNode.selection.requested_parent_ids?.length ? (
                      selectedNode.selection.requested_parent_ids.map((id) =>
                        parentChip(id),
                      )
                    ) : (
                      <span className="context-muted">无</span>
                    )}
                  </div>
                </div>
                <div className="context-parent-row">
                  <span>直接父节点</span>
                  <div>
                    {selectedNode.parent_ids.length ? (
                      selectedNode.parent_ids.map((id) => parentChip(id))
                    ) : (
                      <span className="context-muted">无 · 独立话题</span>
                    )}
                  </div>
                </div>
                <p className="context-reason">
                  {selectedNode.selection.reason || "后端未记录选择原因。"}
                </p>
                {selectedNode.selection.fallback_reason && (
                  <div className="context-fallback">
                    <strong>回退原因</strong>
                    <p>{selectedNode.selection.fallback_reason}</p>
                  </div>
                )}
                <details className="context-details">
                  <summary>
                    候选节点{" "}
                    <span>{selectedNode.selection.candidate_ids.length}</span>
                    <ChevronDown size={13} aria-hidden="true" />
                  </summary>
                  <div className="context-candidates">
                    {selectedNode.selection.candidate_ids.length ? (
                      selectedNode.selection.candidate_ids.map((id) =>
                        parentChip(id),
                      )
                    ) : (
                      <span className="context-muted">没有历史候选节点。</span>
                    )}
                  </div>
                </details>
              </section>
              <section className="context-card">
                <div className="context-section-title">
                  <ScanLine size={15} aria-hidden="true" />
                  <h3>输入预算估算</h3>
                </div>
                <div className="context-budget-numbers">
                  <strong>
                    {number(selectedNode.context.estimated_input_tokens)}
                  </strong>
                  <span>
                    / {number(selectedNode.context.budget_tokens)} 预算单位
                  </span>
                </div>
                <div
                  className="context-budget-track"
                  role="meter"
                  aria-label="上下文输入预算估算"
                  aria-valuemin={0}
                  aria-valuemax={Math.max(
                    selectedNode.context.budget_tokens,
                    1,
                  )}
                  aria-valuenow={Math.min(
                    selectedNode.context.estimated_input_tokens,
                    Math.max(selectedNode.context.budget_tokens, 1),
                  )}
                  aria-valuetext={`${selectedNode.context.estimated_input_tokens} / ${selectedNode.context.budget_tokens} 估算单位`}
                >
                  <span
                    style={{
                      width: `${Math.min(100, Math.max(0, (selectedNode.context.estimated_input_tokens / Math.max(1, selectedNode.context.budget_tokens)) * 100))}%`,
                    }}
                  />
                </div>
                <p className="context-budget-caption">
                  按 UTF-8 字节数与固定消息开销保守估算；非实际 token 数，也非
                  API 计费量。
                </p>
                <div className="context-estimator">
                  估算器 <code>{selectedNode.context.estimator}</code>
                </div>
              </section>
              <section className="context-card">
                <div className="context-section-title">
                  <Layers3 size={15} aria-hidden="true" />
                  <h3>实际历史上下文</h3>
                  <span className="context-count">
                    {selectedNode.context.items.length} 项
                  </span>
                </div>
                <p className="context-section-note">
                  父节点及其相关祖先。展开查看实际送入上下文的内容。
                </p>
                {selectedNode.context.items.length ? (
                  <div className="context-items">
                    {selectedNode.context.items.map((item) => {
                      const source = nodeMap.get(item.node_id);
                      return (
                        <details className="context-item" key={item.node_id}>
                          <summary>
                            <span className="context-item-id">
                              #
                              {source
                                ? turnLabel(source)
                                : item.node_id.slice(0, 8)}
                            </span>
                            <span
                              className={`context-version-pin ${source && item.revision !== undefined && item.revision !== (source.revision ?? 1) ? "is-old" : ""}`}
                              title={
                                source &&
                                item.revision !== undefined &&
                                item.revision !== (source.revision ?? 1)
                                  ? `生成时使用 v${item.revision}，当前节点已为 v${source.revision ?? 1}`
                                  : "本轮生成时记录的上下文版本"
                              }
                            >
                              {item.revision !== undefined
                                ? `v${item.revision}`
                                : "版本未记录"}
                            </span>
                            <span className="context-item-title">
                              {source?.question ?? item.question}
                            </span>
                            <span
                              className={`context-representation ${item.representation === "summary" ? "is-excerpt" : ""}`}
                            >
                              {item.representation === "full" ? "原文" : "截取"}
                            </span>
                            <ChevronDown size={13} aria-hidden="true" />
                          </summary>
                          <div className="context-item-body">
                            {source &&
                              item.revision !== undefined &&
                              item.revision !== (source.revision ?? 1) && (
                                <p className="context-version-warning">
                                  此处保留的是生成时使用的 v{item.revision}{" "}
                                  内容；源节点当前为 v{source.revision ?? 1}。
                                </p>
                              )}
                            <span className="context-content-label">
                              QUESTION
                            </span>
                            <p>{item.question}</p>
                            <span className="context-content-label">
                              {item.representation === "full"
                                ? "ANSWER"
                                : "STORED EXCERPT"}
                            </span>
                            <pre>{item.answer}</pre>
                            <span className="context-item-estimate">
                              该项估算：{number(item.estimated_tokens)} 单位
                            </span>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                ) : (
                  <div className="context-no-items">
                    本轮没有引入历史问答上下文。
                  </div>
                )}
                {selectedNode.context.omitted_node_ids.length > 0 && (
                  <div className="context-omitted">
                    <span>因预算省略的节点</span>
                    <div>
                      {selectedNode.context.omitted_node_ids.map((id) =>
                        parentChip(id),
                      )}
                    </div>
                  </div>
                )}
              </section>
              {Object.keys(selectedNode.metrics).length > 0 && (
                <section className="context-card">
                  <div className="context-section-title">
                    <ScanLine size={15} aria-hidden="true" />
                    <h3>后端记录指标</h3>
                  </div>
                  <dl className="context-metrics">
                    {Object.entries(selectedNode.metrics).map(
                      ([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>
                            {typeof value === "object"
                              ? JSON.stringify(value)
                              : String(value)}
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                </section>
              )}
              <section className="context-card context-history-card">
                <div className="context-section-title">
                  <History size={15} aria-hidden="true" />
                  <h3>历史版本</h3>
                  <span className="context-count">
                    当前 v{selectedRevision}
                  </span>
                </div>
                <p className="context-section-note">
                  只读查看每次保存的回答与父节点，不会切换当前版本。
                </p>
                {isDemo || parentControl.readOnly ? (
                  <p className="context-muted">示例模式不请求后端历史版本。</p>
                ) : (
                  <>
                    <button
                      type="button"
                      className="context-load-versions"
                      onClick={() => void loadVersions()}
                      disabled={history.key === historyKey && history.loading}
                    >
                      {history.key === historyKey && history.loading
                        ? "正在加载历史版本…"
                        : history.key === historyKey && history.items !== null
                          ? "刷新历史版本"
                          : "查看历史版本"}
                    </button>
                    {history.key === historyKey && history.error && (
                      <p className="context-history-error" role="alert">
                        {history.error}
                      </p>
                    )}
                    {history.key === historyKey && history.items !== null && (
                      <div className="context-version-list">
                        {history.items.length ? (
                          [...history.items]
                            .sort(
                              (a, b) => (b.revision ?? 1) - (a.revision ?? 1),
                            )
                            .map((snapshot) => (
                              <details
                                className="context-version-snapshot"
                                key={`${snapshot.id}:${snapshot.revision ?? 1}`}
                              >
                                <summary>
                                  <History size={12} aria-hidden="true" />
                                  <span>v{snapshot.revision ?? 1}</span>
                                  {(snapshot.revision ?? 1) ===
                                    selectedRevision && (
                                    <span className="context-history-current">
                                      当前版本
                                    </span>
                                  )}
                                  <ChevronDown size={13} aria-hidden="true" />
                                </summary>
                                <div className="context-snapshot-body">
                                  <span className="context-content-label">
                                    QUESTION
                                  </span>
                                  <p className="context-snapshot-question">
                                    {snapshot.question}
                                  </p>
                                  <div className="context-snapshot-parents">
                                    <span>直接父节点</span>
                                    {snapshot.parent_ids.length ? (
                                      snapshot.parent_ids.map((id) => {
                                        const source = nodeMap.get(id);
                                        return (
                                          <span
                                            className="context-snapshot-parent"
                                            key={id}
                                            title={source?.question ?? id}
                                          >
                                            #
                                            {source
                                              ? turnLabel(source)
                                              : id.slice(0, 8)}
                                          </span>
                                        );
                                      })
                                    ) : (
                                      <span>无</span>
                                    )}
                                  </div>
                                  <span className="context-content-label">
                                    ANSWER
                                  </span>
                                  <AnswerMarkdown answer={snapshot.answer} />
                                </div>
                              </details>
                            ))
                        ) : (
                          <p className="context-muted">
                            后端尚未记录历史版本。
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </section>
            </>
          ) : (
            <div className="context-empty">
              <ScanLine size={30} strokeWidth={1.2} aria-hidden="true" />
              <h2>看看一个问题的来路</h2>
              <p>点击图中或对话中的节点，查看它的上下文。</p>
            </div>
          )}
        </div>
      )}

      <div className="composer-area">
        <div className="composer-navigation-note">
          <GitBranch size={11} aria-hidden="true" />
          <span>
            {parentControl.picking
              ? "选取模式：点击图中节点可切换指定父节点"
              : parentControl.mode === "auto"
                ? "父节点自动识别 · 点击节点仅用于浏览"
                : "已启用指定父节点 · 浏览节点不会改变指定结果"}
          </span>
          {graph.nodes.length > 0 && tab === "conversation" && (
            <button
              type="button"
              aria-label="滚动到最新对话"
              title="滚动到最新对话"
              onClick={() =>
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: scrollBehavior(),
                })
              }
            >
              <ArrowDown size={13} aria-hidden="true" />
            </button>
          )}
        </div>
        {regenerationTarget && (
          <div className="composer-regeneration-banner">
            <RotateCcw size={14} aria-hidden="true" />
            <div>
              <strong>
                重新生成 #{turnLabel(regenerationTarget)} · v
                {regenerationTarget.revision ?? 1}→v
                {(regenerationTarget.revision ?? 1) + 1}
              </strong>
              <span>调整本轮父节点后重新生成回答，原问题保持不变。</span>
            </div>
            <button
              type="button"
              aria-label="取消重新生成"
              title="取消重新生成"
              disabled={controlsDisabled}
              onClick={parentControl.onCancelRegeneration}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="composer-parent-controls" data-testid="parent-controls">
          <div className="composer-parent-control-header">
            <span className="composer-parent-control-label">
              <GitBranch size={12} aria-hidden="true" />
              父节点
            </span>
            <div
              className="composer-parent-modes"
              role="group"
              aria-label="父节点选择模式"
            >
              {parentModes.map(({ mode, label }) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={parentControl.mode === mode}
                  className={parentControl.mode === mode ? "is-active" : ""}
                  onClick={() => parentControl.onModeChange(mode)}
                  disabled={controlsDisabled}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="composer-parent-pick-row">
            <button
              type="button"
              className={`composer-parent-pick ${parentControl.picking ? "is-active" : ""}`}
              aria-pressed={parentControl.picking}
              disabled={controlsDisabled || parentControl.mode === "auto"}
              onClick={parentControl.onTogglePicking}
              title={
                parentControl.mode === "auto"
                  ? "切换至自动 + 指定或仅指定后，可从图中选取"
                  : "点击图中节点以选择或移除指定父节点"
              }
            >
              <MousePointer2 size={12} aria-hidden="true" />
              在图中选择父节点
            </button>
            {parentControl.mode !== "auto" &&
              parentControl.selectedIds.length > 0 && (
                <button
                  type="button"
                  className="composer-clear-parents"
                  disabled={controlsDisabled}
                  onClick={parentControl.onClear}
                >
                  清空指定
                </button>
              )}
          </div>
          {parentControl.mode !== "auto" &&
            parentControl.selectedIds.length > 0 && (
              <div
                className="composer-selected-parents"
                aria-label="已指定的父节点"
              >
                {parentControl.selectedIds.map((id) => {
                  const source = nodeMap.get(id);
                  return (
                    <span
                      className="composer-parent-pin"
                      key={id}
                      title={source?.question ?? id}
                    >
                      <span className="composer-pin-number">
                        #{source ? turnLabel(source) : id.slice(0, 8)}
                      </span>
                      <span className="composer-pin-question">
                        {source?.question ?? id}
                      </span>
                      <button
                        type="button"
                        disabled={controlsDisabled}
                        aria-label={`移除指定父节点 ${source ? `#${turnLabel(source)}` : id}`}
                        title="移除指定父节点"
                        onClick={() => parentControl.onToggleParent(id)}
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          <p className="composer-parent-explanation">
            {parentControl.mode === "auto"
              ? "系统自动选择直接父节点。"
              : parentControl.mode === "augment"
                ? "指定节点会作为直接父节点，系统可补充其他节点。"
                : parentControl.selectedIds.length === 0
                  ? "仅使用指定的直接父节点；当前未指定，将作为独立问题。"
                  : "仅使用已指定的直接父节点。"}
            {parentControl.mode !== "auto" &&
              "这些父节点的祖先仍可能进入上下文。"}
            <span>选择先用于本次请求，生成成功后才写入图关系。</span>
          </p>
        </div>
        <form
          className={`composer ${pending ? "is-pending" : ""} ${isDemo ? "is-demo" : ""}`}
          onSubmit={(event) => void submit(event)}
        >
          <textarea
            ref={textareaRef}
            aria-label={regenerationTarget ? "重新生成的原问题" : "输入问题"}
            data-testid="question-input"
            placeholder={
              isDemo ? "新建对话后，开始你的探索" : "提出问题，让想法继续连接…"
            }
            value={composerQuestion}
            readOnly={Boolean(regenerationTarget)}
            onChange={(event) => {
              if (!regenerationTarget) onDraftChange(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            disabled={controlsDisabled}
            maxLength={100000}
            rows={2}
          />
          <div className="composer-bottom">
            <div className="composer-model">
              <span
                className={`composer-model-dot ${isDemo ? "is-demo" : ""}`}
              />
              <span>
                {isDemo
                  ? "演示模式"
                  : provider === "mock"
                    ? "Mock · 离线测试"
                    : provider || "等待连接"}
              </span>
            </div>
            <div className="composer-actions">
              <span className="composer-enter-hint">
                <CornerDownLeft size={11} aria-hidden="true" />
                {regenerationTarget ? "重新生成" : "发送"}
              </span>
              <button
                className="composer-send"
                type="submit"
                aria-label={
                  regenerationTarget
                    ? "重新生成回答"
                    : pending
                      ? "正在生成回答"
                      : "发送问题"
                }
                disabled={!composerQuestion.trim() || controlsDisabled}
                data-testid="send-question"
              >
                {pending ? (
                  <span className="composer-spinner" />
                ) : regenerationTarget ? (
                  <RotateCcw size={16} aria-hidden="true" />
                ) : (
                  <ArrowUp size={18} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        </form>
        <p className="composer-footnote">
          {isDemo
            ? "示例数据用于体验 DAG 交互，未调用模型。"
            : "Shift + Enter 换行 · 回答可能存在错误，请核实关键信息。"}
        </p>
      </div>
    </section>
  );
}
