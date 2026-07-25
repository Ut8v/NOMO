import { useCallback, useEffect, useRef, useState } from "react";
import MemoryPanel from "./MemoryPanel";
import type { RobinhoodStatus, TierSetting } from "../api";
import {
  fetchRobinhoodStatus,
  fetchTierSettings,
  saveKeys,
  startRobinhoodLink,
  unlinkRobinhood,
  updateTierSetting,
} from "../api";

interface Props {
  onBack: () => void;
}

const TIER_LABELS: Record<string, { title: string; note: string }> = {
  market_data: { title: "Market data", note: "Quotes, price history, and charts. Runs automatically." },
  portfolio_read: { title: "Portfolio (read only)", note: "Positions, balances, and order history from Robinhood. Runs automatically." },
  execution: { title: "Trading", note: "Order placement arrives in a later phase and always requires confirmation." },
};

export default function SettingsScreen({ onBack }: Props) {
  const [anthropicKey, setAnthropicKey] = useState("");
  const [polygonKey, setPolygonKey] = useState("");
  const [keysBusy, setKeysBusy] = useState(false);
  const [keysMessage, setKeysMessage] = useState<string | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);

  const [robinhood, setRobinhood] = useState<RobinhoodStatus | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const [tiers, setTiers] = useState<TierSetting[]>([]);
  const [tierError, setTierError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [status, tierSettings] = await Promise.all([fetchRobinhoodStatus(), fetchTierSettings()]);
      setRobinhood(status);
      setTiers(tierSettings);
    } catch {
      setLinkError("Could not load settings from the server.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  async function handleSaveKeys() {
    setKeysBusy(true);
    setKeysError(null);
    setKeysMessage(null);
    try {
      const result = await saveKeys({ anthropicApiKey: anthropicKey.trim(), polygonApiKey: polygonKey.trim() });
      if (result.saved) {
        setKeysMessage("Keys validated and saved.");
        setAnthropicKey("");
        setPolygonKey("");
      } else {
        const problems = [result.anthropic, result.polygon]
          .map((check) => check.error)
          .filter(Boolean)
          .join(" ");
        setKeysError(problems || "Validation failed.");
      }
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : "Saving keys failed.");
    } finally {
      setKeysBusy(false);
    }
  }

  async function handleLink() {
    setLinkBusy(true);
    setLinkError(null);
    setFallbackUrl(null);
    // Opened synchronously inside the click gesture so popup blockers allow
    // it; the authorization URL is assigned once the server responds.
    const popup = window.open("", "_blank");
    try {
      const { authorizeUrl, linked } = await startRobinhoodLink();
      if (linked) {
        popup?.close();
        await refresh();
        setLinkBusy(false);
        return;
      }
      if (popup) {
        popup.location.href = authorizeUrl;
      } else {
        setFallbackUrl(authorizeUrl);
      }
      // Poll until tools are registered, not merely until tokens exist.
      let attempts = 0;
      pollRef.current = window.setInterval(async () => {
        attempts += 1;
        const status = await fetchRobinhoodStatus().catch(() => null);
        if (status?.active || attempts > 60) {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setLinkBusy(false);
          setFallbackUrl(null);
          if (status?.active) {
            setRobinhood(status);
            void refresh();
          } else {
            setLinkError("Timed out waiting for Robinhood. Finish authorizing in the opened tab, then link again.");
          }
        }
      }, 2000);
    } catch (err) {
      popup?.close();
      setLinkError(err instanceof Error ? err.message : "Link failed to start.");
      setLinkBusy(false);
    }
  }

  async function handleUnlink() {
    setLinkBusy(true);
    setLinkError(null);
    try {
      await unlinkRobinhood();
      await refresh();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Unlink failed.");
    } finally {
      setLinkBusy(false);
    }
  }

  async function handleTierToggle(tier: string, enabled: boolean) {
    setTierError(null);
    // Optimistic flip; reload on failure.
    setTiers((current) => current.map((t) => (t.tier === tier ? { ...t, enabled } : t)));
    try {
      await updateTierSetting(tier, enabled);
    } catch {
      setTierError("Could not save the toggle.");
      void refresh();
    }
  }

  return (
    <div className="settings">
      <header className="chat-header">
        <span className="chat-title">Settings</span>
        <button className="link-button" onClick={onBack} disabled={keysBusy || linkBusy}>
          Back to chat
        </button>
      </header>

      <section className="settings-section">
        <h2>API keys</h2>
        <p className="muted">
          Replace the stored Anthropic and Polygon keys. Both are validated before anything is saved.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSaveKeys();
          }}
        >
        <label htmlFor="settings-anthropic">Anthropic API key</label>
        <input
          id="settings-anthropic"
          type="password"
          autoComplete="off"
          placeholder="sk-ant-..."
          value={anthropicKey}
          onChange={(e) => setAnthropicKey(e.target.value)}
          disabled={keysBusy}
        />
        <label htmlFor="settings-polygon">Polygon API key</label>
        <input
          id="settings-polygon"
          type="password"
          autoComplete="off"
          placeholder="Your Polygon.io key"
          value={polygonKey}
          onChange={(e) => setPolygonKey(e.target.value)}
          disabled={keysBusy}
        />
        {keysError && <p className="error-text">{keysError}</p>}
        {keysMessage && <p className="success-text">{keysMessage}</p>}
        <button type="submit" disabled={keysBusy || !anthropicKey.trim() || !polygonKey.trim()}>
          {keysBusy ? "Validating..." : "Validate and save"}
        </button>
        </form>
      </section>

      <section className="settings-section">
        <h2>Robinhood</h2>
        {robinhood && (robinhood.linked || robinhood.active) ? (
          <>
            {robinhood.active ? (
              <p className="success-text">
                Connected. {robinhood.tools.length} read only tools available: {robinhood.tools.join(", ")}
              </p>
            ) : (
              <p className="error-text">
                Linked, but the connection to Robinhood failed, so no tools are available. Reconnect or unlink.
              </p>
            )}
            {!robinhood.active && (
              <button onClick={() => void handleLink()} disabled={linkBusy}>
                {linkBusy ? "Waiting for Robinhood..." : "Reconnect"}
              </button>
            )}
            <button className="secondary" onClick={() => void handleUnlink()} disabled={linkBusy}>
              Unlink
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              Links your Robinhood agentic account through the official Trading MCP. A Robinhood page
              opens to authorize access; this phase uses read only tools, and trading is not enabled.
            </p>
            <button onClick={() => void handleLink()} disabled={linkBusy}>
              {linkBusy ? "Waiting for Robinhood..." : "Link Robinhood"}
            </button>
          </>
        )}
        {fallbackUrl && (
          <p className="muted">
            The popup was blocked.{" "}
            <a href={fallbackUrl} target="_blank" rel="noreferrer">
              Open the Robinhood authorization page
            </a>{" "}
            to continue.
          </p>
        )}
        {linkError && <p className="error-text">{linkError}</p>}
      </section>

      <section className="settings-section">
        <h2>Tool access</h2>
        <p className="muted">
          Disabling a tier removes its tools from what Claude can see, not just what it can run.
        </p>
        {tiers.map((tier) => {
          const meta = TIER_LABELS[tier.tier] ?? { title: tier.tier, note: "" };
          return (
            <div key={tier.tier} className="tier-row">
              <div>
                <div className="tier-title">{meta.title}</div>
                <div className="muted tier-note">
                  {meta.note}
                  {tier.tools.length > 0 ? ` Tools: ${tier.tools.join(", ")}` : " No tools registered."}
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={tier.enabled}
                  onChange={(e) => void handleTierToggle(tier.tier, e.target.checked)}
                />
                <span>{tier.enabled ? "On" : "Off"}</span>
              </label>
            </div>
          );
        })}
        {tierError && <p className="error-text">{tierError}</p>}
      </section>

      <MemoryPanel />
    </div>
  );
}
