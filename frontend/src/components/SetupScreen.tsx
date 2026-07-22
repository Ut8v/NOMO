import { useState } from "react";
import type { FormEvent } from "react";
import { saveKeys } from "../api";

interface Props {
  onConfigured: () => void;
  /** Present when the app is already configured, so leaving is allowed. */
  onCancel?: () => void;
}

export default function SetupScreen({ onConfigured, onCancel }: Props) {
  const [anthropicKey, setAnthropicKey] = useState("");
  const [polygonKey, setPolygonKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [anthropicError, setAnthropicError] = useState<string | null>(null);
  const [polygonError, setPolygonError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setAnthropicError(null);
    setPolygonError(null);

    if (!anthropicKey.trim() || !polygonKey.trim()) {
      setFormError("Both keys are required.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await saveKeys({
        anthropicApiKey: anthropicKey.trim(),
        polygonApiKey: polygonKey.trim(),
      });
      if (result.saved) {
        onConfigured();
        return;
      }
      if (!result.anthropic.valid) {
        setAnthropicError(result.anthropic.error ?? "Invalid key.");
      }
      if (!result.polygon.valid) {
        setPolygonError(result.polygon.error ?? "Invalid key.");
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="centered">
      <form className="panel setup-form" onSubmit={handleSubmit}>
        <h1>{onCancel ? "Update API keys" : "Welcome to NOMO"}</h1>
        <p className="muted">
          Both keys are validated with a test call, then stored in a local
          database on this machine. They are never sent anywhere else.
        </p>

        <label htmlFor="anthropic-key">Anthropic API key</label>
        <input
          id="anthropic-key"
          type="password"
          autoComplete="off"
          placeholder="sk-ant-..."
          value={anthropicKey}
          onChange={(e) => setAnthropicKey(e.target.value)}
          disabled={submitting}
        />
        {anthropicError && <p className="error-text">{anthropicError}</p>}

        <label htmlFor="polygon-key">Polygon API key</label>
        <input
          id="polygon-key"
          type="password"
          autoComplete="off"
          placeholder="Your Polygon.io key"
          value={polygonKey}
          onChange={(e) => setPolygonKey(e.target.value)}
          disabled={submitting}
        />
        {polygonError && <p className="error-text">{polygonError}</p>}

        {formError && <p className="error-text">{formError}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Validating..." : "Validate and save"}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel} disabled={submitting}>
            Back to chat
          </button>
        )}
      </form>
    </div>
  );
}
