import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartSpec, ChatMessage, ConversationSummary, PendingOrderView, StoredMessage } from "@nomo/shared";
import { MAX_CHAT_MESSAGES } from "@nomo/shared";
import {
  createConversation,
  deleteConversation,
  fetchUsageTotals,
  getConversation,
  listConversations,
  saveConversationMessages,
} from "../api";
import { streamChat } from "../chatStream";
import ActivityPanel from "./ActivityPanel";
import type { AgentActivity, ToolActivity } from "./ActivityPanel";
import AssistantText from "./AssistantText";
import ChartBlock from "./ChartBlock";
import ChatInput from "./ChatInput";
import OrderCard from "./OrderCard";

interface Props {
  onOpenSettings: () => void;
  onOpenDatabase: () => void;
}

interface ChatFault {
  code: string;
  message: string;
}

export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "chart"; spec: ChartSpec }
  | { kind: "order"; order: PendingOrderView };

export interface UiMessage {
  role: "user" | "assistant";
  blocks: MessageBlock[];
  /** Live tool-call activity for an assistant turn; not persisted. */
  activity?: ToolActivity[];
  /** Live research sub-agent lanes for an assistant turn; not persisted. */
  agents?: AgentActivity[];
}

function formatCost(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function orderRecord(order: PendingOrderView): string {
  const result = order.result ? `. ${order.result.slice(0, 200)}` : "";
  const reason = order.rejectReason ? `. Reason: ${order.rejectReason.slice(0, 200)}` : "";
  const subject =
    order.action === "cancel"
      ? `cancel ${order.ticker} order ${order.brokerRef ?? ""}`.trim()
      : `${order.side} ${order.dollarAmount ? `$${order.dollarAmount} of` : order.quantity} ${order.ticker} ${order.orderType}${order.stopPrice ? ` stop $${order.stopPrice}` : ""}${order.limitPrice ? ` limit $${order.limitPrice}` : ""}`;
  return `[Order record: ${subject}. Status: ${order.status}${reason}${result}]`;
}

/**
 * Flattens a UI message to the plain text the chat API accepts. Chart blocks
 * are omitted rather than replaced with placeholder text: the model never
 * authored a placeholder, and echoing one back teaches it to imitate the
 * placeholder instead of calling render_chart. Order blocks DO flatten into
 * bracketed system records, because Claude must know each order's final
 * outcome on the next turn; the system prompt marks these as app-inserted.
 */
function toChatMessage(message: UiMessage): ChatMessage {
  const content = message.blocks
    .map((block) => {
      if (block.kind === "text") return block.text;
      if (block.kind === "order") return orderRecord(block.order);
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
  return { role: message.role, content };
}

// The UI keeps the full transcript, but requests send a window the server
// accepts, trimmed so the window still opens on a user turn.
function requestWindow(history: UiMessage[]): ChatMessage[] {
  let window = history.map(toChatMessage).filter((message) => message.content.length > 0);
  window = window.slice(-MAX_CHAT_MESSAGES);
  const firstUser = window.findIndex((message) => message.role === "user");
  if (firstUser > 0) {
    window = window.slice(firstUser);
  }
  return window;
}

function hasContent(message: UiMessage): boolean {
  return (
    (message.activity?.length ?? 0) > 0 ||
    (message.agents?.length ?? 0) > 0 ||
    message.blocks.some((block) => block.kind !== "text" || block.text.length > 0)
  );
}

// An assistant message with no content means nothing arrived; dropping it
// keeps failed or stopped turns from leaving a blank bubble in the history.
function dropEmptyReply(setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>) {
  setMessages((current) => {
    const last = current[current.length - 1];
    if (last && last.role === "assistant" && !hasContent(last)) {
      return current.slice(0, -1);
    }
    return current;
  });
}

export default function Chat({ onOpenSettings, onOpenDatabase }: Props) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [fault, setFault] = useState<ChatFault | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [totalCostUsd, setTotalCostUsd] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // True while the viewport is pinned to the bottom. Streaming updates only
  // auto-scroll when this holds, so scrolling up during generation stays put.
  const atBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, []);

  const refreshList = useCallback(async () => {
    setConversations(await listConversations().catch(() => []));
  }, []);

  useEffect(() => {
    void fetchUsageTotals()
      .then((totals) => setTotalCostUsd(totals.costUsd))
      .catch(() => undefined);
  }, []);

  // On mount, restore the most recent conversation so a reload does not lose
  // the transcript.
  useEffect(() => {
    void (async () => {
      const list = await listConversations().catch(() => []);
      setConversations(list);
      const newest = list[0];
      if (!newest) return;
      const detail = await getConversation(newest.id).catch(() => null);
      if (detail) {
        setMessages(detail.messages.map((m) => ({ role: m.role, blocks: m.blocks as MessageBlock[] })));
        setConversationId(detail.id);
      }
    })();
  }, []);

  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Persist after the transcript settles. Skipped while streaming so partial
  // turns are not saved token by token.
  useEffect(() => {
    if (!conversationId || streaming || messages.length === 0) return;
    const stored: StoredMessage[] = messages.map((m) => ({ role: m.role, blocks: m.blocks }));
    const timer = window.setTimeout(() => {
      void saveConversationMessages(conversationId, stored).then(refreshList).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [messages, conversationId, streaming, refreshList]);

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || streaming) return;

      // Sending is an explicit intent to see the new turn: re-pin to the bottom.
      atBottomRef.current = true;
      const history: UiMessage[] = [...messages, { role: "user", blocks: [{ kind: "text", text: content }] }];
      setMessages([...history, { role: "assistant", blocks: [], activity: [], agents: [] }]);
      setDraft("");
      setFault(null);
      setStreaming(true);

      const appendBlock = (append: (blocks: MessageBlock[]) => MessageBlock[]) => {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, blocks: append(last.blocks) };
          }
          return next;
        });
      };

      // Track tool calls on the streaming assistant message for the live view.
      const updateActivity = (update: (activity: ToolActivity[]) => ToolActivity[]) => {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, activity: update(last.activity ?? []) };
          }
          return next;
        });
      };

      // Track research sub-agent lanes on the streaming assistant message.
      const updateAgents = (update: (agents: AgentActivity[]) => AgentActivity[]) => {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, agents: update(last.agents ?? []) };
          }
          return next;
        });
      };

      const abort = new AbortController();
      abortRef.current = abort;

      void (async () => {
        // A brand new chat has no row yet; create one titled from the first
        // message so it appears in history.
        if (!conversationId) {
          const created = await createConversation(content).catch(() => null);
          if (created) {
            setConversationId(created.id);
            void refreshList();
          }
        }

        void streamChat(
          { messages: requestWindow(history) },
          {
            onText: (delta) =>
              appendBlock((blocks) => {
                const last = blocks[blocks.length - 1];
                if (last && last.kind === "text") {
                  return [...blocks.slice(0, -1), { kind: "text", text: last.text + delta }];
                }
                return [...blocks, { kind: "text", text: delta }];
              }),
            // Malformed payloads are dropped rather than rendered; a bad
            // frame must not blank the whole conversation.
            onChart: (spec) => {
              if (spec && Array.isArray(spec.bars) && spec.bars.length > 0) {
                appendBlock((blocks) => [...blocks, { kind: "chart", spec }]);
              }
            },
            onPendingOrder: (order) => {
              if (order && typeof order.id === "string") {
                appendBlock((blocks) => [...blocks, { kind: "order", order }]);
              }
            },
            onTool: (event) =>
              updateActivity((activity) => {
                if (event.phase === "start") {
                  return [...activity, { id: event.id, name: event.name, status: "running", agent: event.agent }];
                }
                return activity.map((a) =>
                  a.id === event.id ? { ...a, status: event.ok ? "done" : "error" } : a,
                );
              }),
            onAgent: (event) =>
              updateAgents((agents) => {
                if (event.phase === "start") {
                  if (agents.some((a) => a.name === event.name)) return agents;
                  return [...agents, { name: event.name, status: "running" }];
                }
                return agents.map((a) =>
                  a.name === event.name ? { ...a, status: event.ok ? "done" : "error" } : a,
                );
              }),
            onUsage: (usage) => setTotalCostUsd(usage.total.costUsd),
            onDone: () => {
              dropEmptyReply(setMessages);
              setStreaming(false);
            },
            onError: (code, message) => {
              dropEmptyReply(setMessages);
              setFault({ code, message });
              setStreaming(false);
            },
          },
          abort.signal,
        );
      })();
    },
    [messages, streaming, conversationId, refreshList],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    dropEmptyReply(setMessages);
    setStreaming(false);
  }, []);

  const updateOrder = useCallback((updated: PendingOrderView) => {
    setMessages((current) =>
      current.map((message) => ({
        ...message,
        blocks: message.blocks.map((block) =>
          block.kind === "order" && block.order.id === updated.id
            ? { kind: "order" as const, order: updated }
            : block,
        ),
      })),
    );
  }, []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    atBottomRef.current = true;
    setMessages([]);
    setConversationId(null);
    setFault(null);
    setDraft("");
    setStreaming(false);
  }, []);

  const openConversation = useCallback(async (id: string) => {
    abortRef.current?.abort();
    atBottomRef.current = true;
    setStreaming(false);
    setFault(null);
    const detail = await getConversation(id).catch(() => null);
    if (detail) {
      setMessages(detail.messages.map((m) => ({ role: m.role, blocks: m.blocks as MessageBlock[] })));
      setConversationId(detail.id);
    }
  }, []);

  const removeConversation = useCallback(
    async (id: string) => {
      await deleteConversation(id).catch(() => undefined);
      await refreshList();
      if (id === conversationId) {
        setMessages([]);
        setConversationId(null);
      }
    },
    [conversationId, refreshList],
  );

  const keyFault = fault?.code === "missing_api_key" || fault?.code === "invalid_api_key";
  const lastIndex = messages.length - 1;

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <aside className="sidebar">
          <div className="sidebar-top">
            <button
              className="new-chat-btn"
              onClick={newChat}
              disabled={messages.length === 0 && !conversationId}
            >
              New chat
            </button>
          </div>
          <nav className="sidebar-list">
            {conversations.length === 0 ? (
              <p className="muted sidebar-empty">No conversations yet.</p>
            ) : (
              conversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`sidebar-item ${conversation.id === conversationId ? "sidebar-item-active" : ""}`}
                >
                  <button
                    className="sidebar-item-title"
                    onClick={() => void openConversation(conversation.id)}
                    title={conversation.title}
                  >
                    {conversation.title}
                  </button>
                  <button
                    className="sidebar-item-del"
                    aria-label="Delete conversation"
                    title="Delete conversation"
                    onClick={() => void removeConversation(conversation.id)}
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))
            )}
          </nav>
        </aside>
      )}

      <div className="chat">
        <header className="chat-header">
          <div className="chat-header-left">
            <button
              className="icon-button"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? "Hide conversations" : "Show conversations"}
              title={sidebarOpen ? "Hide conversations" : "Show conversations"}
            >
              <SidebarIcon />
            </button>
            <span className="chat-title">NOMO</span>
          </div>
          <div className="chat-header-actions">
            {totalCostUsd !== null && (
              <span className="cost-chip" title="Estimated Anthropic API usage, all time">
                ≈ {formatCost(totalCostUsd)}
              </span>
            )}
            <button className="link-button" onClick={onOpenDatabase}>
              Database
            </button>
            <button className="link-button" onClick={onOpenSettings}>
              Settings
            </button>
          </div>
        </header>

        <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <p className="muted chat-empty">
            Ask about markets or request a chart, like a 3 month daily chart of AAPL with the 20 EMA.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`bubble bubble-${message.role}`}>
            {message.role === "assistant" &&
              ((message.activity?.length ?? 0) > 0 || (message.agents?.length ?? 0) > 0) && (
                <ActivityPanel
                  activities={message.activity ?? []}
                  agents={message.agents ?? []}
                  active={streaming && index === lastIndex}
                />
              )}
            {message.blocks.map((block, blockIndex) => {
              if (block.kind === "text") {
                return message.role === "assistant" ? (
                  <AssistantText key={blockIndex} text={block.text} />
                ) : (
                  <span key={blockIndex}>{block.text}</span>
                );
              }
              if (block.kind === "chart") return <ChartBlock key={blockIndex} spec={block.spec} />;
              return <OrderCard key={block.order.id} order={block.order} onResolved={updateOrder} />;
            })}
            {streaming && index === lastIndex && message.role === "assistant" && (
              <span className="caret" />
            )}
          </div>
        ))}
      </div>

      {fault && (
        <div className="chat-error">
          <span>{fault.message}</span>
          {keyFault && (
            <button className="link-button" onClick={onOpenSettings}>
              Update API keys
            </button>
          )}
        </div>
      )}

      <ChatInput
        value={draft}
        onChange={setDraft}
        onSend={() => send(draft)}
        onStop={stop}
        streaming={streaming}
      />
      </div>
    </div>
  );
}

function SidebarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}
