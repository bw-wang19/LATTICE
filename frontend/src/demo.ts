import type { ConversationGraph, TurnNode } from "./types";

export const DEMO_ID = "lattice-local-demo";
const created = "2026-10-16T01:00:00Z";
const entries: Array<{
  question: string;
  answer: string;
  parents: number[];
  reason: string;
}> = [
  {
    question: "如何设计一个会自动整理思路的 AI 聊天工具？",
    answer:
      "可以把每轮问答视为一个节点，用有向边记录问题之间的上下文依赖。\n\n我们可以沿着三个方向展开：\n\n- **自动关联**：判断一个新问题依赖哪些历史节点。\n- **上下文管理**：沿依赖关系组织输入，保留原始问答。\n- **交互界面**：让分支、交汇和原文可以直接浏览。\n\n这样，一个话题可以自然分叉，多个方向也可以在之后重新汇合。",
    parents: [],
    reason: "起始问题，没有历史依赖。",
  },
  {
    question: "新问题的父节点，可以怎样自动识别？",
    answer:
      "先召回候选，再判断依赖，是一个可实现的起点。\n\n1. 用关键词或语义相似度筛选历史节点。\n2. 将候选摘要和当前问题交给选择器。\n3. 输出零个、一个或多个父节点，并校验它们确实来自当前会话。\n\n**语义相似不等于上下文依赖。** 后续需要专门评估指代、跨分支综合和新话题的识别能力。",
    parents: [1],
    reason: "展开起始问题中的自动关联方向。",
  },
  {
    question: "如何沿 DAG 管理每一轮的上下文？",
    answer:
      "从选中的父节点出发，收集它们的祖先，并对共享历史去重。\n\n- 优先保留直接父节点的内容。\n- 在输入预算内加入相关祖先。\n- 记录哪些内容用了原文、哪些用了摘要、哪些被省略。\n\n原始问答应持续保存，压缩只影响本次模型输入。依赖结构能帮助筛选信息，但仍然需要验证跨分支信息是否被错误遗漏。",
    parents: [1],
    reason: "展开起始问题中的上下文管理方向。",
  },
  {
    question: "界面怎么呈现分支与多个父节点的交汇？",
    answer:
      "用一张可以缩放、拖动的图呈现依赖结构，旁边保留完整对话。\n\n点击图中节点，定位原始问答；点击问答，也能在图中定位。选中一个节点时，显示它的直接父节点与实际使用的上下文。\n\n连线由系统自动生成。**浏览哪个节点与下一轮使用哪些上下文，是两个独立的动作。**",
    parents: [1],
    reason: "展开起始问题中的界面交互方向。",
  },
  {
    question: "如果父节点判断不确定，应该怎么办？",
    answer:
      "可以先保留候选和选择依据，让不确定性能够被检查。\n\n目前的工程基线可以在选择器失败时回退到启发式策略，并明确记录回退原因。研究阶段可进一步比较：\n\n- 只使用高置信度父节点；\n- 适度增加候选上下文；\n- 针对模糊指代请求澄清。\n\n这些策略需要在漏选、误选与额外成本之间进行实验比较。",
    parents: [2],
    reason: "追问自动父节点识别的不确定性。",
  },
  {
    question: "可以联合优化父节点识别与上下文管理吗？",
    answer:
      "可以，这是两个研究方向的交汇点。\n\n父节点决定从哪里取信息，上下文策略决定以什么粒度、多少预算保留信息。可以把它们共同写成一个受预算约束的选择问题：\n\n```text\n当前问题 + 候选历史\n  → 依赖选择\n  → 预算内组织上下文\n  → 回答与评估\n```\n\n比较固定依赖与联合策略，在相同输入预算下是否更好地保留关键事实。这里是一种待验证的研究设想，实际增益需要实验支撑。",
    parents: [2, 3],
    reason: "同时依赖父节点识别与上下文管理两个分支，形成多父节点交汇。",
  },
  {
    question: "应该设计哪些实验来验证效果？",
    answer:
      "至少分开衡量结构、回答和成本。\n\n| 维度 | 例子 |\n| --- | --- |\n| 依赖质量 | 父节点精确率、召回率、多父节点识别 |\n| 回答质量 | 事实保留、指代消解、跨分支综合 |\n| 成本 | 实际输入 token、选择器开销、端到端延迟 |\n\n与完整历史、滑动窗口、统一摘要和检索基线比较，并做选择器与上下文策略的消融。样例数据只能演示界面，不能替代实验结论。",
    parents: [5, 6],
    reason: "综合不确定性处理与联合优化，讨论验证方案。",
  },
];

const byteEstimate = (text: string) => new TextEncoder().encode(text).length;
const nodes: TurnNode[] = [];
entries.forEach((entry, index) => {
  const sequence = index + 1;
  const parent_ids = entry.parents.map((n) => `demo-${n}`);
  const ancestorIds = new Set<string>();
  const collect = (id: string) => {
    if (ancestorIds.has(id)) return;
    ancestorIds.add(id);
    nodes.find((node) => node.id === id)?.parent_ids.forEach(collect);
  };
  parent_ids.forEach(collect);
  const items = nodes
    .filter((node) => ancestorIds.has(node.id))
    .map((node) => ({
      node_id: node.id,
      representation: "full" as const,
      question: node.question,
      answer: node.answer,
      estimated_tokens: byteEstimate(node.question + node.answer),
    }));
  nodes.push({
    id: `demo-${sequence}`,
    conversation_id: DEMO_ID,
    sequence,
    question: entry.question,
    answer: entry.answer,
    summary: entry.question,
    parent_ids,
    selection: {
      parent_ids,
      strategy: "demo",
      reason: entry.reason,
      fallback_reason: null,
      candidate_ids: nodes.map((node) => node.id),
    },
    context: {
      items,
      omitted_node_ids: [],
      estimated_input_tokens: items.reduce(
        (total, item) => total + item.estimated_tokens,
        byteEstimate(entry.question),
      ),
      budget_tokens: 8192,
      estimator: "utf8_bytes_conservative",
    },
    metrics: {},
    created_at: created,
  });
});

export const demoGraph: ConversationGraph = {
  conversation: {
    id: DEMO_ID,
    title: "重新想象 AI 对话",
    instructions: "",
    created_at: created,
  },
  nodes,
  edges: nodes.flatMap((node) =>
    node.parent_ids.map((source) => ({
      source,
      target: node.id,
      kind: "depends_on" as const,
    })),
  ),
};

export function emptyGraph(): ConversationGraph {
  return {
    conversation: {
      id: "",
      title: "新的探索",
      instructions: "",
      created_at: new Date().toISOString(),
    },
    nodes: [],
    edges: [],
  };
}
