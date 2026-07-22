import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@nomo/shared";
import { MAX_CHAT_MESSAGES } from "@nomo/shared";
import { streamChat } from "../chatStream";
import ChatInput from "./ChatInput";

// The UI keeps the full transcript, but requests send a window the server
// accepts, trimmed so the window still opens on a user turn.
function requestWindow(history: ChatMessage[]): ChatMessage[] {
  let window = history.slice(-MAX_CHAT_MESSAGES);
  const firstUser = window.findIndex((message) => message.role === "user");
  if (firstUser > 0) {
    window = window.slice(firstUser);
  }
  return window;
}

interface Props {
  onOpenSettings: () => void;
}

interface ChatFault {
  code: string;
  message: string;
}

export default function Chat({ onOpenSettings }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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

      const history: ChatMessage[] = [...messages, { role: "user", content }];
      setMessages([...history, { role: "assistant", content: "" }]);
      setDraft("");
      setFault(null);
      setStreaming(true);

      const appendToReply = (delta: string) => {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { role: "assistant", content: last.content + delta };
          }
          return next;
        });
      };

      const dropEmptyReply = () => dropTrailingEmptyAssistant(setMessages);

      const abort = new AbortController();
      abortRef.current = abort;

      void streamChat(
        { messages: requestWindow(history) },
        {
          onText: appendToReply,
          onDone: () => {
            dropEmptyReply();
            setStreaming(false);
          },
          onError: (code, message) => {
            dropEmptyReply();
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
    dropTrailingEmptyAssistant(setMessages);
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
            Ask about markets, strategies, or anything else. Trading tools arrive in later phases.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`bubble bubble-${message.role}`}>
            {message.content}
            {streaming && index === messages.length - 1 && message.role === "assistant" && (
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

// An empty assistant bubble means nothing arrived; dropping it keeps failed
// or stopped turns from leaving a blank message in the history.
function dropTrailingEmptyAssistant(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
) {
  setMessages((current) => {
    const last = current[current.length - 1];
    if (last && last.role === "assistant" && last.content === "") {
      return current.slice(0, -1);
    }
    return current;
  });
}
