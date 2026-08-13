import { useCallback, useEffect, useState } from "react";
import type { SetupStatus } from "@nomo/shared";
import { fetchSetupStatus } from "./api";
import SetupScreen from "./components/SetupScreen";
import SettingsScreen from "./components/SettingsScreen";
import DatabaseView from "./components/DatabaseView";
import PortfolioView from "./components/PortfolioView";
import Chat from "./components/Chat";

export default function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showDb, setShowDb] = useState(false);
  const [showPortfolio, setShowPortfolio] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setError(null);
      setStatus(await fetchSetupStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reach the server.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  if (error) {
    return (
      <div className="centered">
        <div className="panel">
          <h1>NOMO</h1>
          <p className="error-text">{error}</p>
          <p>Make sure the server is running, then try again.</p>
          <button onClick={() => void loadStatus()}>Retry</button>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="centered">
        <p className="muted">Loading...</p>
      </div>
    );
  }

  // Chat stays mounted while settings is open so the conversation held in
  // component state survives a key update.
  return (
    <>
      {!status.configured && (
        <SetupScreen
          onConfigured={() => {
            setShowSetup(false);
            void loadStatus();
          }}
        />
      )}
      {status.configured && showSetup && <SettingsScreen onBack={() => setShowSetup(false)} />}
      {status.configured && showDb && <DatabaseView onBack={() => setShowDb(false)} />}
      {status.configured && showPortfolio && <PortfolioView onBack={() => setShowPortfolio(false)} />}
      {status.configured && (
        <div className={showSetup || showDb || showPortfolio ? "hidden" : undefined}>
          <Chat
            onOpenSettings={() => setShowSetup(true)}
            onOpenDatabase={() => setShowDb(true)}
            onOpenPortfolio={() => setShowPortfolio(true)}
          />
        </div>
      )}
    </>
  );
}
