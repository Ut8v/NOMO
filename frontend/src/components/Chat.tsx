import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartSpec, ChatMessage } from "@nomo/shared";
import { MAX_CHAT_MESSAGES } from "@nomo/shared";
import { streamChat } from "../chatStream";
import ChartBlock from "./ChartBlock";
import ChatInput from "./ChatInput";

interface Props {
  onOpenSettings: () => void;
}

interface ChatFault {
  code: string;
  message: string;
}

export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "chart"; spec: ChartSpec };

export interface UiMessage {
  role: "user" | "assistant";
  blocks: MessageBlock[];
}

/**
 * Flattens a UI message to the plain text the chat API accepts. Chart blocks
 * are omitted rather than replaced with placeholder text: the model never
 * authored a placeholder, and echoing one back teaches it to imitate the
 * placeholder instead of calling render_chart. The system prompt tells the
 * model that previously rendered charts are not in the transcript.
 */
function toChatMessage(message: UiMessage): ChatMessage {
  const content = message.blocks
    .filter((block): block is { kind: "text"; text: string } => block.kind === "text")
    .map((block) => block.text)
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
  return message.blocks.some((block) => block.kind === "chart" || block.text.length > 0);
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
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

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
          onChart: (spec) => appendBlock((blocks) => [...blocks, { kind: "chart", spec }]),
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
    },
    [messages, streaming],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    dropEmptyReply(setMessages);
    setStreaming(false);
  }, []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setFault(null);
    setDraft("");
    setStreaming(false);
  }, []);

  const keyFault = fault?.code === "missing_api_key" || fault?.code === "invalid_api_key";
  const lastIndex = messages.length - 1;

  return (
    <div className="chat">
      <header className="chat-header">
        <span className="chat-title">NOMO</span>
        <div className="chat-header-actions">
          <button className="link-button" onClick={newChat} disabled={messages.length === 0}>
            New chat
          </button>
          <button className="link-button" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="muted chat-empty">
            Ask about markets or request a chart, like a 3 month daily chart of AAPL with the 20 EMA.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`bubble bubble-${message.role}`}>
            {message.blocks.map((block, blockIndex) =>
              block.kind === "text" ? (
                <span key={blockIndex}>{block.text}</span>
              ) : (
                <ChartBlock key={blockIndex} spec={block.spec} />
              ),
            )}
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
