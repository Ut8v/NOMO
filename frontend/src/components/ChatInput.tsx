import type { KeyboardEvent } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
}

export default function ChatInput({ value, onChange, onSend, onStop, streaming }: Props) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter during IME composition commits the candidate, not the message.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  }

  return (
    <div className="chat-input">
      <textarea
        rows={1}
        placeholder="Message NOMO. Enter to send, Shift+Enter for a new line."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={streaming}
      />
      {streaming ? (
        <button className="secondary" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button onClick={onSend} disabled={!value.trim()}>
          Send
        </button>
      )}
    </div>
  );
}
