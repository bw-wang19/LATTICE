# LATTICE 文献阅读清单

核查日期：2026-10-21。目标是同时支持可用的开源聊天产品与可评估的科研方法。

本清单按与项目的关系筛选，不是穷尽式综述。优先使用正式论文页、作者论文与 arXiv 原文；明确标注预印本。已核查题名、年份和主要机制，最接近工作的依赖与上下文规则核对了方法正文；未复现其结果。“对 LATTICE 的用途”“待验证问题”和实验建议是本项目的研究判断。

P0 是第一轮精读，共 8 篇；P1 按正在开发的模块阅读；P2 暂作背景或工程参考。22 篇主清单后另列 5 篇选读，不要求一次读完。

## 阅读时先区分的问题

- **图里是什么**：完整问答、回答内实体、记忆笔记、工具步骤、检索子问题，还是会话快照？
- **边表示什么**：回应、话题相近、证据依赖、执行先后，还是用户显式选择？
- **什么时候建边**：新问题回答前，已发生的 agent 步骤之后，还是看到最终答案后的事后归因？
- **图怎样进入输入**：只取祖先、主路径加旁支摘要、图检索，还是仅用于展示？

相似度关联、reply-to、证据依赖与因果影响不能直接当作同一种标签。自动建图也不等于已经证明图改善了回答。

## A. 自动依赖与结构化上下文：先确定最接近的工作

### 01 · P0 · Context-Agent: Dynamic Discourse Trees for Non-Linear Dialogue

Junan Hu et al.，**Findings of ACL 2026**。 [正式论文与 PDF](https://aclanthology.org/2026.findings-acl.1472/) · [作者代码](https://github.com/Steve2457/Context-Agent)

每轮自动进行话题与分支管理，节点为单父结构；使用活跃路径内容及其他分支摘要组织上下文，并提出非线性任务基准 NTM。与本项目的自然追问场景高度接近。

**精读**：方法中的分支创建、切换和 fork point 选择；上下文构造；NTM 任务与指标。**落点**：作为自动单父树基线，测试多父集合能否改善跨分支综合；不能只用“自动判断分支”主张创新。

### 02 · P0 · ContextWeaver: Selective and Dependency-Structured Memory Construction for LLM Agents

Yating Wu et al.，**2026，arXiv 预印本**；本次核对 v2，2026-10-14。 [论文](https://arxiv.org/abs/2604.23069) · [方法正文 §3](https://arxiv.org/html/2604.23069v2)

为已发生的 agent 步骤自动选择多个前驱，追溯祖先并维护依赖摘要。选中祖先保留完整步骤；非祖先仍保留 thought/action，仅压缩 observation。正文给出 LLM 判依赖，主要实验使用较便宜的评分。

**精读**：§3.1–3.3、等总预算比较及实现配置。**落点**：依赖图算法的直接近邻。LATTICE 的在线问答父选设置有所不同，但方法贡献仍需通过实验体现。

### 03 · P0 · CMT-RAG: Complementary Memory Traces for Multi-turn Multi-hop RAG

Lang Zhou et al.，**2026，arXiv 预印本**。 [论文](https://arxiv.org/abs/2607.26470) · [方法与 MuMu-QA](https://arxiv.org/html/2607.26470v2)

把当前问题拆成含历史依赖的子问题 trace，复用检索证据，并维护跨轮 trace DAG。MuMu-QA 提供子问题依赖监督。节点粒度是子问题及其证据，不能归为普通实体知识图谱。

**精读**：§2–3、附录 A 的图构造与数据切分。**落点**：研究在线依赖预测、跨分支证据组合与依赖监督数据；复现前另查代码、数据和模型资源的实际开放状态。

### 04 · P1 · Tokengeist: Multi-Turn Attribution Tracing in Agentic Conversations

Jessica Tang, Shraddha Barke, Sharad Agarwal，**2026，arXiv 预印本**。 [论文](https://arxiv.org/abs/2607.22610) · [方法正文](https://arxiv.org/html/2607.22610)

给定已生成的回答片段，在完整记录上递归恢复跨轮来源 DAG，属于事后归因。论文提出 MTCABench；不能仅凭论文中的发布计划就假定数据已经开放。

**精读**：§4.2 的任务边界、依赖类型和图指标。**落点**：借鉴标注与递归来源评价；在线父选不能看到当前问题的目标答案，事后归因可作为独立诊断任务。

### 05 · P1 · A Large-Scale Corpus for Conversation Disentanglement

Jonathan K. Kummerfeld et al.，**ACL 2019**。 [正式论文](https://aclanthology.org/P19-1374/)

人工标注多人 IRC 中一条消息回应一个或多个历史消息，提供回复图及建边评价。它提供重要的父集合标注先例，但“在回应谁”与“生成答案需要哪些证据”不同。

**精读**：标签定义、分歧裁决和边级 Precision/Recall/F1。**落点**：设计本项目的标注指南；转换原数据时，应将新话题 self-link 转为空父集合，避免引入自环。

## B. 工程界面与分支管理：回到可查、可回看的初衷

### 06 · P0 · Graphologue: Exploring Large Language Model Responses with Interactive Diagrams

Peiling Jiang, Jude Rayan, Steven P. Dow, Haijun Xia，**UIST 2023**。 [论文](https://arxiv.org/abs/2305.11473) · [作者 PDF](https://hci.ucsd.edu/papers/graphologue.pdf)

将回答中的实体和关系自动转为可交互图，并支持关联追问。主要是回答内容图，不是跨轮问答依赖图。

**精读**：形成性研究、图与文本联动、用户任务与评价。**落点**：把历史查找、理解和回访作为独立产品目标，研究原文定位与导航是否真正减少用户负担。

### 07 · P1 · Conversations in Space: Non-Linear LLM Interaction in Everyday Use

Rifat Mehreen Amin et al.，**2026，arXiv 预印本**；本次采用 v2，2026-09-15。 [论文](https://arxiv.org/abs/2605.15848) · [方法正文](https://arxiv.org/html/2605.15848v2)

CanvasConvo 同步聊天与空间画布，用户显式创建分支。其日常使用研究有助理解非线性交互与上下文继承的可理解性。v1 题名为 *Conversations in Space: Structuring Non-Linear LLM Interactions on a Canvas*。

**精读**：分支继承规则、field deployment、用户对上下文的理解。**落点**：设计延迟回访、查找旧依据和探索多个方案的用户实验。

### 08 · P1 · Context Branching for LLM Conversations: A Version Control Approach to Exploratory Programming

Bhargav Chickmagalur Nanjundappa, Spandan Maaheshwari，**2025，arXiv 预印本**。 [论文](https://arxiv.org/abs/2512.13914) · [方法及局限](https://arxiv.org/html/2512.13914v1)

ContextBranch 提供 checkpoint、branch、switch 和 inject，当前分支及注入选择主要由用户操作；自动建议属于后续工作。

**精读**：隔离与注入规则、编程任务设计、§7.1。**落点**：借鉴分支状态和上下文污染场景；人工分支可作参考上限，但其线性对照不代表全部强基线。

### 09 · P2 · Contextual Memory Virtualisation: DAG-Based State Management and Structurally Lossless Trimming for LLM Agents

Cosmo Santoni，**2026，arXiv 预印本**。 [论文](https://arxiv.org/abs/2602.22402) · [方法正文](https://arxiv.org/html/2602.22402)

用不可变会话快照记录分支谱系；当前快照关系实际是单父结构。“Structurally lossless”不表示全部工具内容都保留，trimming 会移除部分工具观测等信息。

**落点**：快照、恢复、版本和实验重放。它不承担自然问题的语义父节点识别，不适合直接当在线多父选择器比较。

## C. 记忆与检索：用于实现模块和构造强基线

### 10 · P0 · A-MEM: Agentic Memory for LLM Agents

Wujiang Xu et al.，**NeurIPS 2025**，arXiv 页面注明会议信息。 [论文](https://arxiv.org/abs/2502.12110)

生成带属性的记忆笔记，自动寻找历史关联、建立链接，并演化旧笔记。它确实自动建链接，但关联网络不等同于带祖先上下文语义的问答依赖 DAG。

**精读**：新记忆、候选召回、判边、记忆演化及消融。**落点**：实现“召回候选→模型选择”的方法基线，比较图类型与记忆粒度的影响。

### 11 · P0 · Beyond Memory Construction: Rethinking Memory Access for LLM-based Conversational Agents

Donghua Cai et al.，**2026，arXiv 预印本**；方法名 **Threader**。 [论文](https://arxiv.org/abs/2609.33226)

保留原始交互，以增量话题分段、多视角表示和局部证据匹配改善访问，不依赖多父问答图。

**精读**：分段、检索与证据匹配；建设记忆的成本。**落点**：这是“无需 DAG 的强原文检索”对照，帮助分辨收益来自建图，还是来自更好的分段与索引。

### 12 · P1 · MemGPT: Towards LLMs as Operating Systems

Charles Packer et al.，**2023 预印本，2024 修订**。 [论文](https://arxiv.org/abs/2310.08560)

通过分层记忆和函数调用管理有限主上下文与外部存储。**落点**：按需读回原文、记忆工具、循环控制；理解上下文管理怎样进入 agent loop，而非将它当作问答父选算法。

### 13 · P1 · Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory

Prateek Chhikara et al.，**ECAI 2025 会议论文**，另有 2025 arXiv 版。 [出版社论文页](https://journals.sagepub.com/doi/10.3233/FAIA251160) · [arXiv](https://arxiv.org/abs/2504.19413)。出版社当前页面登记的在线日期为 2026-08-25，会议归属为 ECAI 2025。

抽取事实并更新记忆，再进行相关记忆检索；图变体侧重实体关系。**落点**：事实型记忆基线、更新策略和总成本核算。其实体节点与关系边不能直接解释为问答父节点。

### 14 · P1 · Zep: A Temporal Knowledge Graph Architecture for Agent Memory

**2025，arXiv 预印本**。 [论文](https://arxiv.org/abs/2501.13956)

以 Graphiti 组织 episode、实体、事实及时间信息，支持记忆检索和事实变化。**落点**：来源追溯、时间有效性和事实更新；它的知识关系与来源联系不是完整问答之间的父边。

## D. 压缩与按需展开：替换当前截取策略

### 15 · P0 · LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression

Huiqiang Jiang et al.，**ACL 2024**，2023 预印本。 [正式论文](https://aclanthology.org/2024.acl-long.91/)

结合问题相关性、粗到细选择、动态压缩比例和内容重排。**精读**：压缩与预算分配机制。**落点**：检验同样输入预算下，依赖结构是否比强问题相关压缩保留更多必要证据。

### 16 · P1 · RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation

Fangyuan Xu, Weijia Shi, Eunsol Choi，**ICLR 2024**。 [论文](https://arxiv.org/abs/2310.04408) · [正式会议 PDF](https://proceedings.iclr.cc/paper_files/paper/2024/file/bda88ed2892f5e61c9a9bf215c566913-Paper-Conference.pdf)

训练抽取式或生成式压缩器，为下游任务保留有用内容，也允许不添加无关信息。**落点**：压缩目标应服务于当前回答；可以比较“检索后压缩”与“依赖选择后压缩”，不要只与统一摘要比较。

### 17 · P1 · A Human-Inspired Reading Agent with Gist Memory of Very Long Contexts

Kuang-Huei Lee et al.，**ICML 2024**；方法名 **ReadAgent**。 [正式论文](https://proceedings.mlr.press/v235/lee24c.html) · [arXiv](https://arxiv.org/abs/2402.09727)

将长文档分段形成 gist，必要时由 agent 回看原文。**落点**：摘要作为索引与导航，原文按需恢复；主要任务是长文档阅读，不能直接视为对话父选实验。

### 18 · P1 · LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression

Zhuoshi Pan et al.，**Findings of ACL 2024**。 [正式论文](https://aclanthology.org/2024.findings-acl.57/)

通过数据蒸馏训练 token 选择模型，侧重任务无关压缩。**落点**：提供另一类压缩实现；应与问题相关的 LongLLMLingua 分开描述，比较压缩粒度、保真度和运行开销。

## E. 评估：同时测依赖、回答与用户回访

### 19 · P0 · LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory

Di Wu et al.，**ICLR 2025**，2024 预印本。 [正式论文](https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html) · [数据与代码](https://github.com/xiaowu0162/LongMemEval)

测信息提取、跨会话推理、时间推理、知识更新和拒答，也分析索引、检索和阅读。**精读**：证据位置、记忆粒度与检索评价。**落点**：第一阶段的回答与证据召回实验；证据 session 不等于逐轮直接父边标签。

### 20 · P1 · Evaluating Very Long-Term Conversational Memory of LLM Agents

Adyasha Maharana et al.，**ACL 2024**；基准名 **LoCoMo**。 [正式论文](https://aclanthology.org/2024.acl-long.747/) · [作者数据与代码](https://github.com/snap-research/locomo)

以长期对话测试问答、事件总结等能力。**落点**：多跳和时间问题、跨 session 记忆；其对话生成依据的事件图不是问答依赖图金标准，生活对话也不完全代表技术探索聊天。

### 21 · P1 · Locomo-Plus: Beyond-Factual Cognitive Memory Evaluation Framework for LLM Agents

Yifei Li et al.，**ACL 2026**。 [正式论文](https://aclanthology.org/2026.acl-long.1150/)

测试旧线索与新问题表面相似度低时，能否应用隐含目标、状态或约束，以约束一致性评价。**落点**：检验“必要依赖不等于语义相似”；仍需另加分支局部作用域与多父标签。

### 22 · P1 · Lost in the Middle: How Language Models Use Long Contexts

Nelson F. Liu et al.，**TACL 2024**，2023 预印本。 [正式论文](https://aclanthology.org/2024.tacl-1.9/)

通过改变证据位置与上下文长度研究长输入利用能力。**落点**：借鉴受控干预方法，固定必要信息，改变分支间隔、干扰量与证据位置；不能用旧模型的结果替代当前模型上的实测。

## F. 5 篇按需选读

| 编号 | 文献与来源 | 什么时候读、注意什么 |
| --- | --- | --- |
| 23 | [Grounded Continuation: A Linear-Time Runtime Verifier for LLM Conversations](https://arxiv.org/abs/2605.14175)，2026 预印本 | 做前提撤销、纠错与失效传播时读；图围绕 claim 支持关系，而非完整问答节点。 |
| 24 | [Sensecape: Enabling Multilevel Exploration and Sensemaking with Large Language Models](https://arxiv.org/abs/2305.11483)，UIST 2023 | 做多层抽象、空间整理和用户 sensemaking 研究时读。 |
| 25 | [ChatGraPhT: A Visual Conversation Interface for Multi-Path Reflection with Agentic LLM Support](https://arxiv.org/abs/2512.22790)，2025 预印本 | 做多父合并和 agent 辅助画布时读；包含用户选节点与 agent 图操作，不宜简单归为纯手动或每轮自动父选。 |
| 26 | [ChainForge: A Visual Toolkit for Prompt Engineering and LLM Hypothesis Testing](https://arxiv.org/abs/2309.09128)，CHI 2024 | 借鉴模型／提示／评估器的实验工作台；其图是实验数据流。 |
| 27 | [Graph of Thoughts: Solving Elaborate Problems with Large Language Models](https://arxiv.org/abs/2308.09687)，AAAI 2024 | 了解推理聚合与图执行；主要是单任务解题，不是历史问答父选。 |

## 工程项目另列，不算论文

- [ThoughtDAG](https://github.com/chenxiachan/thoughtdag)：检查可见上下文、分支、来源与回溯交互；当前官方说明还包含历史召回，不能笼统认为只有手动组织。以具体功能与版本比较，不据产品演示判断算法效果。
- [Canvas Chat](https://github.com/ericmjl/canvas-chat)：参考分支、合并、祖先上下文呈现与插件实现。它是工程项目，未在本清单中计入已发表论文。

## 第一轮精读的顺序与产物

| 顺序 | 阅读 | 读完要留下什么 |
| --- | --- | --- |
| 1 | 01 Context-Agent | 自动树基线：话题、父节点与上下文规则；NTM 如何评价。 |
| 2 | 02 ContextWeaver | 多父依赖与祖先使用规则；哪些部分与现有框架重合。 |
| 3 | 03 CMT-RAG | 问答节点与子问题 trace 的取舍；依赖监督如何构造。 |
| 4 | 06 Graphologue | 两个用户任务：定位旧依据、延迟后恢复探索。 |
| 5 | 19 LongMemEval | 第一版可运行的回答评价与证据召回协议。 |
| 6 | 10 A-MEM | 自动记忆关联的候选召回、判边与消融基线。 |
| 7 | 11 Threader | 无需依赖图的强检索对照，防止误归因图收益。 |
| 8 | 15 LongLLMLingua | 相同上下文预算下的强压缩对照。 |

后续做依赖标注时补 04、05；做压缩时补 16–18；做交互与版本时补 07–09；做更多回答评价时补 20–22。

## 转成工程与论文工作的建议

以下是研究设计建议，不是上述论文已经替 LATTICE 证明的结论。

### 先把研究问题写清楚

在只看当前问题和过去历史的条件下，如何选择充分且不过度的多父依赖，并在固定预算内保留当前问题需要的原文或摘要？同时，显式依赖是否帮助用户在分支探索后找回依据？

不要预设所有祖先都应进入输入，也不要假设全局指令、用户修订和分支局部假设总能用同一种边表示。需要决定关系类型、有效范围和更新语义。

### 保留三条独立证据链

1. **依赖识别**：直接父集合 P/R/F1、空父与多父识别、祖先证据覆盖、冗余；允许多个等价的充分证据集合。
2. **回答与成本**：正确率、约束一致性、拒答；画质量—全部模型调用 token—端到端延迟曲线，包含父选与压缩开销。
3. **产品收益**：旧信息定位耗时、定位正确率、回访恢复时间、原文核对成功率和任务完成情况；图布局与交互收益应单独评价。

### 最小对比与消融

- 全历史、最近窗口、统一摘要、强分段／检索与问题相关压缩。
- 自动单父树、自动多父 DAG、人工依赖 oracle；回答模型保持一致。
- 相同证据集合下比较不同组织方式，控制“拿到了什么”之后再分析结构收益。
- 分别替换候选召回、父集合选择、祖先扩展和压缩，避免全部一起改。
- 同时报告相同回答输入预算与相同总调用预算的比较。
- 做时间回放：第 t 轮不能读取未来问答或当前目标答案。

### 对齐原始动机的诊断样例

- 分支 A → B/C 干扰 → 返回 A。
- 同一实体／术语，但属于不同分支假设。
- 同时需要 A 与 B 的互补证据。
- 一条旧结论已被局部修订，重新访问时应继承正确版本。
- 追问助手长回答中的某个片段，稍后继续阅读未展开部分。
- 隔一段时间回访，找到原始条件与证据，而不只看到压缩后的结论。

其中前四类可以先做受控数据，最后两类更适合真实用户任务。现有公开基准不能自动替代这些场景的依赖标注和用户实验。

## 每篇精读记录模板

```text
题名／版本／发表状态：
任务和实际用户场景：
节点与边的定义：
建边时可见的信息（是否包含当前或未来答案）：
候选召回与父集合决策：
实际模型输入包含哪些信息：
预算、模型与总成本口径：
公开代码／数据是否实际取得：
最强对照与关键消融：
适合移植到 LATTICE 的部分：
与本项目重合的贡献：
需要自己验证的改进假设：
```
