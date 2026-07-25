import ReactMarkdown from "react-markdown";

interface Props {
  text: string;
}

/**
 * Renders assistant text as Markdown. Raw HTML is not enabled, so model
 * output cannot inject markup; only standard Markdown formatting renders.
 * Links open in a new tab.
 */
export default function AssistantText({ text }: Props) {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
