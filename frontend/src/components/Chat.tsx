import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartSpec, ChatMessage, ConversationSummary, PendingOrderView, StoredMessage } from "@nomo/shared";
import { MAX_CHAT_MESSAGES } from "@nomo/shared";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  saveConversationMessages,
} from "../api";
import { streamChat } from "../chatStream";
import AssistantText from "./AssistantText";
import ChartBlock from "./ChartBlock";
import ChatInput from "./ChatInput";
import OrderCard from "./OrderCard";

interface Props {
  onOpenSettings: () => void;
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
}

function orderRecord(order: PendingOrderView): string {
  const result = order.result ? `. ${order.result.slice(0, 200)}` : "";
  const reason = order.rejectReason ? `. Reason: ${order.rejectReason.slice(0, 200)}` : "";
  const subject =
    order.action === "cancel"
      ? `cancel ${order.ticker} order ${order.brokerRef ?? ""}`.trim()
      : `${order.side} ${order.quantity} ${order.ticker} ${order.orderType}${order.limitPrice ? ` at $${order.limitPrice}` : ""}`;
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
  return message.blocks.some((block) => block.kind !== "text" || block.text.length > 0);
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

export default function Chat({ onOpenSettings }: Props) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [fault, setFault] = useState<ChatFault | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refreshList = useCallback(async () => {
    setConversations(await listConversations().catch(() => []));
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

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

      const history: UiMessage[] = [...messages, { role: "user", blocks: [{ kind: "text", text: content }] }];
      setMessages([...history, { role: "assistant", blocks: [] }]);
      setDraft("");
      setFault(null);
      setStreaming(true);

      const appendBlock = (append: (blocks: MessageBlock[]) => MessageBlock[]) => {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { role: "assistant", blocks: append(last.blocks) };
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
    setMessages([]);
    setConversationId(null);
    setFault(null);
    setDraft("");
    setStreaming(false);
    setShowHistory(false);
  }, []);

  const openConversation = useCallback(async (id: string) => {
    abortRef.current?.abort();
    setStreaming(false);
    setFault(null);
    setShowHistory(false);
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
    <div className="chat">
      <header className="chat-header">
        <span className="chat-title">NOMO</span>
        <div className="chat-header-actions">
          <button className="link-button" onClick={() => setShowHistory((v) => !v)} disabled={conversations.length === 0}>
            History
          </button>
          <button className="link-button" onClick={newChat} disabled={messages.length === 0 && !conversationId}>
            New chat
          </button>
          <button className="link-button" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      </header>

      {showHistory && (
        <div className="history-panel">
          {conversations.length === 0 && <p className="muted">No saved conversations yet.</p>}
          {conversations.map((conversation) => (
            <div key={conversation.id} className={`history-row ${conversation.id === conversationId ? "history-active" : ""}`}>
              <button className="history-open" onClick={() => void openConversation(conversation.id)}>
                {conversation.title}
              </button>
              <button
                className="history-delete"
                aria-label="Delete conversation"
                onClick={() => void removeConversation(conversation.id)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="muted chat-empty">
            Ask about markets or request a chart, like a 3 month daily chart of AAPL with the 20 EMA.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`bubble bubble-${message.role}`}>
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
  );
}
