export interface Conversation {
  id: string;
  title: string;
  instructions: string;
  created_at: string;
  revision?: number;
}

export interface ParentSelection {
  parent_ids: string[];
  strategy: string;
  reason: string;
  fallback_reason: string | null;
  candidate_ids: string[];
  mode?: ParentMode;
  requested_parent_ids?: string[];
}

export interface ContextItem {
  node_id: string;
  representation: "full" | "summary";
  question: string;
  answer: string;
  estimated_tokens: number;
  revision?: number;
}

export interface ContextBundle {
  items: ContextItem[];
  omitted_node_ids: string[];
  estimated_input_tokens: number;
  budget_tokens: number;
  estimator: string;
}

export interface TurnNode {
  id: string;
  conversation_id: string;
  sequence: number;
  question: string;
  answer: string;
  summary: string;
  parent_ids: string[];
  selection: ParentSelection;
  context: ContextBundle;
  metrics: Record<string, unknown>;
  created_at: string;
  revision?: number;
  updated_at?: string | null;
  stale?: boolean;
  stale_reason?: string | null;
}

export type ParentMode = "auto" | "augment" | "manual";

export interface ParentRequest {
  parent_mode: ParentMode;
  parent_ids: string[];
}

/** Shared controls: browsing and choosing generation context are separate actions. */
export interface ParentControls {
  mode: ParentMode;
  selectedIds: string[];
  picking: boolean;
  disabledIds: string[];
  regenerationTarget: TurnNode | null;
  busy: boolean;
  readOnly: boolean;
  onModeChange: (mode: ParentMode) => void;
  onTogglePicking: () => void;
  onToggleParent: (id: string) => void;
  onClear: () => void;
  onCancelRegeneration: () => void;
  onStartRegeneration: (id: string) => void;
}

export interface DependencyEdge {
  source: string;
  target: string;
  kind: "depends_on";
}

export interface ConversationGraph {
  conversation: Conversation;
  nodes: TurnNode[];
  edges: DependencyEdge[];
}

export interface Health {
  status: string;
  name: string;
  version: string;
  answer_provider: string;
  routing_strategy: string;
}
