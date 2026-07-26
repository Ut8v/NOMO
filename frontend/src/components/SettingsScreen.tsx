import { useCallback, useEffect, useRef, useState } from "react";
import MemoryPanel from "./MemoryPanel";
import type { RobinhoodStatus, TierSetting } from "../api";
import {
  fetchRobinhoodAccount,
  fetchRobinhoodStatus,
  fetchTierSettings,
  listRobinhoodAccounts,
  saveKeys,
  saveRobinhoodAccount,
  startRobinhoodLink,
  unlinkRobinhood,
  updateTierSetting,
} from "../api";

/** Pulls account_number strings out of the get_accounts response, shape-agnostic. */
function extractAccountNumbers(data: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (key === "account_number" && typeof v === "string") found.add(v);
        else walk(v);
      }
    }
  };
  walk(data);
  return [...found];
}

interface Props {
  onBack: () => void;
}

const TIER_LABELS: Record<string, { title: string; note: string }> = {
  market_data: { title: "Market data", note: "Quotes, price history, and charts. Runs automatically." },
  portfolio_read: {
    title: "Portfolio (read only)",
    note: "Positions, balances, P/L, fundamentals, and watchlists from Robinhood. Runs automatically.",
  },
  account_write: {
    title: "Account changes",
    note: "Editing watchlists and scanners. Reversible, moves no money, and runs automatically. Turn off to prevent any account changes.",
  },
  execution: { title: "Trading", note: "Placing or cancelling orders. Never runs automatically; every order requires your confirmation." },
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

  const [accountNumber, setAccountNumber] = useState("");
  const [savedAccount, setSavedAccount] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [accountOptions, setAccountOptions] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [status, tierSettings, account] = await Promise.all([
        fetchRobinhoodStatus(),
        fetchTierSettings(),
        fetchRobinhoodAccount().catch(() => ({ accountNumber: null })),
      ]);
      setRobinhood(status);
      setTiers(tierSettings);
      setSavedAccount(account.accountNumber);
      if (account.accountNumber) setAccountNumber(account.accountNumber);
    } catch {
      setLinkError("Could not load settings from the server.");
    }
  }, []);

  async function handleSaveAccount() {
    setAccountBusy(true);
    setAccountError(null);
    setAccountMessage(null);
    try {
      const { accountNumber: saved } = await saveRobinhoodAccount(accountNumber.trim());
      setSavedAccount(saved);
      setAccountMessage("Trading account saved.");
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "Could not save the account.");
    } finally {
      setAccountBusy(false);
    }
  }

  async function handleLoadAccounts() {
    setAccountBusy(true);
    setAccountError(null);
    try {
      const { accounts } = await listRobinhoodAccounts();
      const options = extractAccountNumbers(accounts);
      setAccountOptions(options);
      if (options.length === 0) setAccountError("No account numbers found in the Robinhood response.");
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "Could not load accounts.");
    } finally {
      setAccountBusy(false);
    }
  }

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
        <h2>Trading account</h2>
        <p className="muted">
          The Robinhood account orders are placed against. Required before any order can be simulated or
          placed, and it is never chosen automatically. Use an agentic-enabled account, and set spending
          limits in Robinhood.
        </p>
        {savedAccount ? (
          <p className="success-text">Current account: {savedAccount}</p>
        ) : (
          <p className="muted">No account selected yet.</p>
        )}
        <label htmlFor="settings-account">Account number</label>
        <input
          id="settings-account"
          type="text"
          autoComplete="off"
          placeholder="Your Robinhood account number"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          disabled={accountBusy}
        />
        {accountOptions.length > 0 && (
          <div className="account-options">
            {accountOptions.map((option) => (
              <button
                key={option}
                type="button"
                className="secondary"
                onClick={() => setAccountNumber(option)}
              >
                {option}
              </button>
            ))}
          </div>
        )}
        {accountError && <p className="error-text">{accountError}</p>}
        {accountMessage && <p className="success-text">{accountMessage}</p>}
        <div className="account-actions">
          <button onClick={() => void handleSaveAccount()} disabled={accountBusy || !accountNumber.trim()}>
            {accountBusy ? "Working..." : "Save account"}
          </button>
          {robinhood?.active && (
            <button className="secondary" onClick={() => void handleLoadAccounts()} disabled={accountBusy}>
              Load my accounts
            </button>
          )}
        </div>
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
