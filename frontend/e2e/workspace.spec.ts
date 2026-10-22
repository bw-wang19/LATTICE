import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function send(page: Page, question: string, count: number) {
  await page.getByTestId("question-input").fill(question);
  await page.getByTestId("send-question").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(count);
  await expect(page.getByTestId("question-input")).toBeEnabled();
}

test("demo shows branching, graph/history navigation, search and actual context inspection", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await expect(page.getByTestId("question-input")).toBeDisabled();
  await page.locator('.react-flow__node[data-id="demo-2"]').click();
  await expect(page.getByTestId("turn-2")).toHaveClass(/is-selected/);
  await page.getByRole("tab", { name: "上下文检查" }).click();
  await expect(page.getByTestId("context-inspector")).toContainText(
    "展开起始问题中的自动关联方向",
  );
  await page.locator('.react-flow__node[data-id="demo-6"]').click();
  await expect(page.getByTestId("context-inspector")).toContainText(
    "形成多父节点交汇",
  );
  await expect(
    page.locator(".context-parent-row .chat-parent-chip"),
  ).toHaveCount(2);
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await page
    .getByRole("button", { name: "在图中定位节点 03", exact: true })
    .click();
  await expect(
    page.locator('.react-flow__node[data-id="demo-3"] .dag-card'),
  ).toHaveClass(/dag-card--selected/);
  await page
    .getByRole("textbox", { name: "搜索对话节点" })
    .fill("不存在的节点XYZ");
  await expect(page.getByRole("status")).toContainText("没有匹配的节点");
  await page.getByRole("button", { name: "清除节点搜索" }).click();
  await expect(page.getByRole("textbox", { name: "搜索对话节点" })).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "显示完整图谱" }).click();
  await page.locator('.react-flow__node[data-id="demo-6"]').click();
  await expect(
    page.getByTestId("turn-6").locator(".chat-question"),
  ).toBeInViewport();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出图谱", exact: true }).click();
  const download = await downloadEvent;
  const exportedPath = await download.path();
  expect(exportedPath).not.toBeNull();
  const exported = JSON.parse(await readFile(exportedPath!, "utf8"));
  expect(exported.nodes).toHaveLength(7);
  expect(exported.edges).toHaveLength(8);
  expect(errors).toEqual([]);
});

test("real backend automatically creates multi-parent DAG and restores saved conversation", async ({
  page,
}) => {
  const payloads: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/conversations\/[^/]+\/turns$/.test(request.url())
    ) {
      payloads.push(request.postDataJSON());
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "新建对话" }).click();
  await send(page, "Explain SQLite backups.", 1);
  await send(page, "Explain PostgreSQL replication.", 2);
  await send(page, "Compare SQLite backups and PostgreSQL replication.", 3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByTestId("turn-3")).toContainText("[MOCK]");
  await page.getByRole("tab", { name: "上下文检查" }).click();
  await expect(
    page.locator(".context-parent-row .chat-parent-chip"),
  ).toHaveCount(2);
  await expect(page.getByTestId("context-inspector")).toContainText(
    "heuristic",
  );
  await expect(page.locator(".context-item")).toHaveCount(2);
  expect(payloads).toHaveLength(3);
  payloads.forEach((payload) =>
    expect(Object.keys(payload as object)).toEqual(["question"]),
  );
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByTestId("question-input")).toBeEnabled();
});

test("failed answers preserve input and can be retried in the existing conversation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.route("**/api/conversations/*/turns", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ detail: "测试：模型服务暂时不可用。" }),
    }),
  );
  await page.getByTestId("question-input").fill("Explain SQLite backups.");
  await page.getByTestId("send-question").click();
  await expect(page.getByRole("alert")).toContainText("模型服务暂时不可用");
  await expect(page.getByTestId("question-input")).toHaveValue(
    "Explain SQLite backups.",
  );
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.unroute("**/api/conversations/*/turns");
  await page.getByTestId("send-question").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.getByTestId("question-input")).toHaveValue("");
});

test("mobile switches map/chat views and can start a conversation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(page.getByTestId("conversation-history")).toBeVisible();
  await page.getByRole("button", { name: "打开会话导航" }).click();
  await page.getByRole("button", { name: "新建对话" }).click();
  await send(page, "Explain SQLite backups.", 1);
  await expect(page.getByTestId("turn-1")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
});

test("switching conversations disables sending until the requested graph is loaded", async ({
  page,
}) => {
  const first = (await (
    await page.request.post("http://127.0.0.1:8021/api/conversations", {
      data: { title: "Race source A" },
    })
  ).json()) as { id: string };
  const second = (await (
    await page.request.post("http://127.0.0.1:8021/api/conversations", {
      data: { title: "Race target B" },
    })
  ).json()) as { id: string };
  await page.addInitScript(
    (id) => localStorage.setItem("lattice.workspace.v1", id),
    first.id,
  );
  await page.goto("/");
  await expect(page.getByTestId("question-input")).toBeEnabled();
  await page
    .getByTestId("question-input")
    .fill("Do not send while navigating.");
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/conversations/${second.id}/graph`, async (route) => {
    await ready;
    await route.continue();
  });
  await page.getByRole("button", { name: /Race target B/ }).click();
  await expect(page.getByTestId("question-input")).toBeDisabled();
  await page.keyboard.press("Enter");
  const graph = (await (
    await page.request.get(
      `http://127.0.0.1:8021/api/conversations/${first.id}/graph`,
    )
  ).json()) as { nodes: unknown[] };
  expect(graph.nodes).toHaveLength(0);
  release();
  await expect(page.getByTestId("question-input")).toBeEnabled();
  await expect(page.locator(".breadcrumb")).toContainText("Race target B");
  await expect(page.getByTestId("question-input")).toHaveValue("");
});
