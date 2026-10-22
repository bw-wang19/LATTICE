import { expect, test, type Page } from "@playwright/test";
import type { ConversationGraph, TurnNode } from "../src/types";

const backend = "http://127.0.0.1:8021";

async function createConversation(page: Page) {
  const response = await page.request.post(`${backend}/api/conversations`, {
    data: { title: `Parent controls ${test.info().title}` },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function createTurn(
  page: Page,
  conversationId: string,
  question: string,
  parentIds: string[] = [],
) {
  const response = await page.request.post(
    `${backend}/api/conversations/${conversationId}/turns`,
    {
      data: { question, parent_mode: "manual", parent_ids: parentIds },
    },
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as TurnNode;
}

async function graph(page: Page, conversationId: string) {
  const response = await page.request.get(
    `${backend}/api/conversations/${conversationId}/graph`,
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ConversationGraph;
}

async function openConversation(page: Page, id: string, count: number) {
  await page.addInitScript(
    (conversationId) =>
      localStorage.setItem("lattice.workspace.v1", conversationId),
    id,
  );
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(count);
  await expect(page.getByTestId("question-input")).toBeEnabled();
}

function graphNode(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function toggleGraphParent(page: Page, id: string, selected: boolean) {
  await graphNode(page, id).locator(".dag-card-question").click();
  await expect(graphNode(page, id).locator(".dag-card")).toHaveAttribute(
    "data-parent-selected",
    String(selected),
  );
}

async function sendTurn(
  page: Page,
  conversationId: string,
  question: string,
  count: number,
) {
  await page.getByTestId("question-input").fill(question);
  const responseEvent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/conversations/${conversationId}/turns`),
  );
  await page.getByTestId("send-question").click();
  const response = await responseEvent;
  expect(response.ok()).toBeTruthy();
  const saved = (await response.json()) as TurnNode;
  await expect(page.locator(".react-flow__node")).toHaveCount(count);
  await expect(page.getByTestId("question-input")).toBeEnabled();
  return saved;
}

async function seedRegeneration(page: Page) {
  const conversation = await createConversation(page);
  const original = await createTurn(
    page,
    conversation.id,
    "Explain SQLite backups.",
  );
  const target = await createTurn(
    page,
    conversation.id,
    "Describe a SQLite backup schedule.",
    [original.id],
  );
  const descendant = await createTurn(
    page,
    conversation.id,
    "Expand that backup schedule into a checklist.",
    [target.id],
  );
  const later = await createTurn(
    page,
    conversation.id,
    "Explain sourdough starter maintenance.",
  );
  return { conversation, original, target, descendant, later };
}

test("manual graph pins are exact and augment preserves pins while adding relevant history", async ({
  page,
}) => {
  const conversation = await createConversation(page);
  const sqlite = await createTurn(
    page,
    conversation.id,
    "Explain SQLite backups.",
  );
  const postgres = await createTurn(
    page,
    conversation.id,
    "Explain PostgreSQL replication.",
  );
  await openConversation(page, conversation.id, 2);

  await page.getByRole("button", { name: "仅指定", exact: true }).click();
  await page
    .getByRole("button", { name: "在图中选择父节点", exact: true })
    .click();
  await toggleGraphParent(page, sqlite.id, true);
  await page.getByRole("button", { name: "完成选择", exact: true }).click();
  expect((await graph(page, conversation.id)).nodes).toHaveLength(2);
  await expect(page.locator(".composer-parent-pin")).toContainText("#01");
  await page.screenshot({
    path: "test-results/parent-controls-desktop.png",
    fullPage: true,
  });

  const manual = await sendTurn(
    page,
    conversation.id,
    "Compare SQLite backups and PostgreSQL replication.",
    3,
  );
  expect(manual.parent_ids).toEqual([sqlite.id]);
  expect(manual.selection.mode).toBe("manual");
  expect(manual.selection.requested_parent_ids).toEqual([sqlite.id]);
  expect(manual.context.items.map((item) => item.node_id)).toEqual([sqlite.id]);

  await page.getByRole("button", { name: "自动 + 指定", exact: true }).click();
  await page
    .getByRole("button", { name: "在图中选择父节点", exact: true })
    .click();
  await toggleGraphParent(page, sqlite.id, true);
  await page.getByRole("button", { name: "完成选择", exact: true }).click();
  const augmented = await sendTurn(
    page,
    conversation.id,
    "How does PostgreSQL replication handle replication lag?",
    4,
  );
  expect(augmented.selection.mode).toBe("augment");
  expect(augmented.selection.requested_parent_ids).toEqual([sqlite.id]);
  expect(augmented.parent_ids).toEqual(
    expect.arrayContaining([sqlite.id, postgres.id]),
  );
  await page.getByRole("tab", { name: "上下文检查" }).click();
  await expect(page.locator(".context-mode-badge")).toHaveText("自动 + 指定");
});

test("manual with no pins creates an independent root even for a related question", async ({
  page,
}) => {
  const conversation = await createConversation(page);
  await createTurn(page, conversation.id, "Explain SQLite backups.");
  await openConversation(page, conversation.id, 1);
  await page.getByRole("button", { name: "仅指定", exact: true }).click();
  await expect(page.locator(".composer-parent-explanation")).toContainText(
    "当前未指定，将作为独立问题",
  );
  const saved = await sendTurn(
    page,
    conversation.id,
    "Explain SQLite backups in more detail.",
    2,
  );
  expect(saved.parent_ids).toEqual([]);
  expect(saved.selection.mode).toBe("manual");
  expect(saved.selection.requested_parent_ids).toEqual([]);
  expect(saved.context.items).toEqual([]);
  expect((await graph(page, conversation.id)).edges).toEqual([]);
});

test("regeneration can connect a later unrelated node, retain identity, stale descendants and preserve versions", async ({
  page,
}) => {
  const { conversation, original, target, descendant, later } =
    await seedRegeneration(page);
  await openConversation(page, conversation.id, 4);
  await page.getByTestId("question-input").fill("Keep this unsent follow-up.");
  await page
    .getByRole("button", { name: "在图中定位节点 02", exact: true })
    .click();
  await page.getByRole("tab", { name: "上下文检查" }).click();
  await page.getByRole("button", { name: "查看历史版本", exact: true }).click();
  await expect(page.locator(".context-version-snapshot")).toHaveCount(1);
  await page
    .getByTestId("context-inspector")
    .getByRole("button", { name: "调整父节点并重新生成", exact: true })
    .click();
  await expect(page.getByTestId("question-input")).toHaveValue(target.question);
  await expect(page.getByTestId("question-input")).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(graphNode(page, target.id)).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(graphNode(page, descendant.id)).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await toggleGraphParent(page, original.id, false);
  await toggleGraphParent(page, later.id, true);
  await page.getByRole("button", { name: "完成选择", exact: true }).click();
  const before = (await graph(page, conversation.id)).nodes.find(
    (node) => node.id === target.id,
  )!;
  expect(before.parent_ids).toEqual([original.id]);
  expect(before.revision).toBe(1);

  const regeneratedEvent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/turns/${target.id}/regenerate`),
  );
  await page.getByRole("button", { name: "重新生成回答", exact: true }).click();
  const response = await regeneratedEvent;
  expect(response.ok()).toBeTruthy();
  const updated = (await response.json()) as ConversationGraph;
  expect(updated.nodes).toHaveLength(4);
  const current = updated.nodes.find((node) => node.id === target.id)!;
  expect(current.id).toBe(target.id);
  expect(current.question).toBe(target.question);
  expect(current.revision).toBe(2);
  expect(current.parent_ids).toEqual([later.id]);
  expect(updated.nodes.find((node) => node.id === descendant.id)?.stale).toBe(
    true,
  );
  expect(updated.edges).toContainEqual({
    source: later.id,
    target: target.id,
    kind: "depends_on",
  });
  await expect(page.getByTestId("question-input")).toHaveValue(
    "Keep this unsent follow-up.",
  );
  await expect(
    graphNode(page, target.id).locator(".dag-card-version"),
  ).toHaveText("v2");
  await expect(graphNode(page, descendant.id).locator(".dag-card")).toHaveClass(
    /dag-card--stale/,
  );
  await expect(page.locator(".context-version-snapshot")).toHaveCount(0);
  await page.getByRole("button", { name: "查看历史版本", exact: true }).click();
  await expect(page.locator(".context-version-snapshot")).toHaveCount(2);
  const versions = page.locator(".context-version-snapshot");
  await versions.nth(0).locator("summary").click();
  await versions.nth(1).locator("summary").click();
  await expect(versions.nth(0).locator(".context-snapshot-parent")).toHaveText(
    "#04",
  );
  await expect(versions.nth(1).locator(".context-snapshot-parent")).toHaveText(
    "#01",
  );
  await expect(versions.nth(1).locator(".chat-markdown")).toHaveText(
    target.answer,
  );
  await graphNode(page, descendant.id).locator(".dag-card-question").click();
  await expect(page.getByTestId("context-inspector")).toContainText(
    "上游已更新，需重新生成",
  );
  await expect(page.locator(".context-version-pin.is-old")).toHaveText("v1");
});

test("failed regeneration keeps the requested parents, original version and draft available for retry", async ({
  page,
}) => {
  const { conversation, original, target, later } =
    await seedRegeneration(page);
  await openConversation(page, conversation.id, 4);
  await page
    .getByTestId("question-input")
    .fill("A draft to preserve after retry.");
  await page
    .getByTestId("turn-2")
    .getByRole("button", { name: "调整父节点并重新生成", exact: true })
    .click();
  await toggleGraphParent(page, original.id, false);
  await toggleGraphParent(page, later.id, true);
  await page.getByRole("button", { name: "完成选择", exact: true }).click();
  await page.route(
    `**/api/turns/${target.id}/regenerate`,
    (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ detail: "测试：重新生成服务暂时不可用。" }),
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "重新生成回答", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("重新生成服务暂时不可用");
  await expect(
    page.getByRole("button", { name: "重新生成回答", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("question-input")).toHaveValue(target.question);
  await expect(page.locator(".composer-parent-pin")).toContainText("#04");
  const unchanged = (await graph(page, conversation.id)).nodes.find(
    (node) => node.id === target.id,
  )!;
  expect(unchanged.revision).toBe(1);
  expect(unchanged.parent_ids).toEqual([original.id]);
  const requestEvent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/api/turns/${target.id}/regenerate`),
  );
  await page.getByRole("button", { name: "重新生成回答", exact: true }).click();
  expect((await requestEvent).postDataJSON()).toEqual({
    parent_mode: "manual",
    parent_ids: [later.id],
    expected_revision: 1,
  });
  await expect(page.locator(".composer-regeneration-banner")).toHaveCount(0);
  await expect(page.getByTestId("question-input")).toHaveValue(
    "A draft to preserve after retry.",
  );
  const retried = (await graph(page, conversation.id)).nodes.find(
    (node) => node.id === target.id,
  )!;
  expect(retried.revision).toBe(2);
  expect(retried.parent_ids).toEqual([later.id]);
});

test("mobile parent picking returns to chat and submits the selected context", async ({
  page,
}) => {
  const conversation = await createConversation(page);
  const parent = await createTurn(
    page,
    conversation.id,
    "Explain SQLite backups.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await openConversation(page, conversation.id, 1);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(page.getByTestId("conversation-history")).toBeVisible();
  await page.getByRole("button", { name: "仅指定", exact: true }).click();
  await page
    .getByRole("button", { name: "在图中选择父节点", exact: true })
    .click();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await toggleGraphParent(page, parent.id, true);
  await page.screenshot({
    path: "test-results/parent-controls-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "完成选择", exact: true }).click();
  await expect(page.getByTestId("conversation-history")).toBeVisible();
  await expect(page.locator(".composer-parent-pin")).toContainText("#01");
  const saved = await sendTurn(
    page,
    conversation.id,
    "Build on this backup plan.",
    2,
  );
  expect(saved.parent_ids).toEqual([parent.id]);
  expect(saved.selection.mode).toBe("manual");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("mobile can remove an inherited stale parent and cancel regeneration back to its draft", async ({
  page,
}) => {
  const conversation = await createConversation(page);
  const root = await createTurn(
    page,
    conversation.id,
    "Explain SQLite backups.",
  );
  const child = await createTurn(
    page,
    conversation.id,
    "Outline a backup schedule.",
    [root.id],
  );
  const grandchild = await createTurn(
    page,
    conversation.id,
    "Expand the schedule into a checklist.",
    [child.id],
  );
  const update = await page.request.post(
    `${backend}/api/turns/${root.id}/regenerate`,
    {
      data: { parent_mode: "manual", parent_ids: [], expected_revision: 1 },
    },
  );
  expect(update.ok()).toBeTruthy();
  const updatedGraph = (await update.json()) as ConversationGraph;
  expect(updatedGraph.nodes.find((node) => node.id === child.id)?.stale).toBe(
    true,
  );
  expect(
    updatedGraph.nodes.find((node) => node.id === grandchild.id)?.stale,
  ).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await openConversation(page, conversation.id, 3);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page
    .getByTestId("question-input")
    .fill("Keep the mobile draft when cancelling.");
  await page
    .getByTestId("turn-3")
    .getByRole("button", { name: "调整父节点并重新生成", exact: true })
    .click();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await expect(graphNode(page, child.id)).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await expect(graphNode(page, child.id).locator(".dag-card")).toHaveAttribute(
    "data-parent-selected",
    "true",
  );
  await toggleGraphParent(page, child.id, false);
  await expect(graphNode(page, child.id)).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(graphNode(page, child.id)).toBeDisabled();
  await page
    .getByRole("button", { name: "取消图谱重新生成", exact: true })
    .click();
  await expect(page.getByTestId("conversation-history")).toBeVisible();
  await expect(page.getByTestId("question-input")).toHaveValue(
    "Keep the mobile draft when cancelling.",
  );
  await expect(page.getByTestId("question-input")).not.toHaveAttribute(
    "readonly",
    "",
  );
  await expect(page.locator(".composer-regeneration-banner")).toHaveCount(0);
  expect(
    (await graph(page, conversation.id)).nodes.find(
      (node) => node.id === grandchild.id,
    )?.revision,
  ).toBe(1);
});
