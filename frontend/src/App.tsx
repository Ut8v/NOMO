import { useCallback, useEffect, useState } from "react";
import type { SetupStatus } from "@nomo/shared";
import { fetchSetupStatus } from "./api";
import SetupScreen from "./components/SetupScreen";
import Chat from "./components/Chat";

export default function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);

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

  if (!status.configured || showSetup) {
    return (
      <SetupScreen
        onConfigured={() => {
          setShowSetup(false);
          void loadStatus();
        }}
      />
    );
  }

  return <Chat onOpenSettings={() => setShowSetup(true)} />;
}
