import type {
  Conversation,
  ConversationGraph,
  Health,
  ParentRequest,
  TurnNode,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(
      "无法连接后端，请确认 LATTICE 服务已启动，然后重试。",
      0,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      "后端未返回有效数据，请检查服务地址和代理设置。",
      response.status,
    );
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? (body as { detail: unknown }).detail
        : null;
    const message =
      typeof detail === "string"
        ? detail
        : response.status === 422
          ? "问题未通过校验，请检查输入长度或上下文预算。"
          : `请求失败（${response.status}），请稍后重试。`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export const api = {
  health: () => request<Health>("/healthz"),
  conversations: () => request<Conversation[]>("/api/conversations"),
  createConversation: (title: string) =>
    request<Conversation>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  graph: (id: string) =>
    request<ConversationGraph>(
      `/api/conversations/${encodeURIComponent(id)}/graph`,
    ),
  send: (id: string, question: string, parents?: ParentRequest) =>
    request<TurnNode>(`/api/conversations/${encodeURIComponent(id)}/turns`, {
      method: "POST",
      body: JSON.stringify({ question, ...parents }),
    }),
  regenerate: (id: string, parents: ParentRequest, expectedRevision: number) =>
    request<ConversationGraph>(
      `/api/turns/${encodeURIComponent(id)}/regenerate`,
      {
        method: "POST",
        body: JSON.stringify({
          ...parents,
          expected_revision: expectedRevision,
        }),
      },
    ),
  versions: (id: string) =>
    request<TurnNode[]>(`/api/turns/${encodeURIComponent(id)}/versions`),
};
