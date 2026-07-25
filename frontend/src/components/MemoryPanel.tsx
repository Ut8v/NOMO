import { useCallback, useEffect, useState } from "react";
import type { MemoryView } from "@nomo/shared";
import { deleteMemory, distillLessons, listMemories, updateMemory } from "../api";

/**
 * Settings section for trader profile memories. The user approves, edits, or
 * deletes anything Claude recorded or distilled. Only approved memories are
 * injected into the prompt; none of them can affect order execution.
 */
export default function MemoryPanel() {
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setMemories(await listMemories().catch(() => []));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request failed.");
    }
  }

  async function handleDistill() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await distillLessons();
      setMessage(result.note);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Distillation failed.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(memory: MemoryView) {
    setEditingId(memory.id);
    setEditValue(memory.content);
  }

  const pending = memories.filter((m) => m.status === "pending");
  const active = memories.filter((m) => m.status === "approved" && m.active);
  const inactive = memories.filter((m) => m.status === "approved" && !m.active);

  function renderMemory(memory: MemoryView) {
    const isEditing = editingId === memory.id;
    return (
      <div key={memory.id} className="memory-row">
        {isEditing ? (
          <input
            className="memory-edit"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            maxLength={500}
          />
        ) : (
          <span className="memory-content">{memory.content}</span>
        )}
        <div className="memory-actions">
          {isEditing ? (
            <>
              <button
                className="memory-btn"
                onClick={() =>
                  void run(async () => {
                    await updateMemory(memory.id, { content: editValue.trim() });
                    setEditingId(null);
                  })
                }
                disabled={!editValue.trim()}
              >
                Save
              </button>
              <button className="memory-btn secondary" onClick={() => setEditingId(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {memory.status === "pending" && (
                <button
                  className="memory-btn"
                  onClick={() => void run(() => updateMemory(memory.id, { status: "approved" }))}
                >
                  Approve
                </button>
              )}
              {memory.status === "approved" && (
                <button
                  className="memory-btn secondary"
                  onClick={() => void run(() => updateMemory(memory.id, { active: !memory.active }))}
                >
                  {memory.active ? "Deactivate" : "Reactivate"}
                </button>
              )}
              <button className="memory-btn secondary" onClick={() => startEdit(memory)}>
                Edit
              </button>
              <button className="memory-btn danger" onClick={() => void run(() => deleteMemory(memory.id))}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="settings-section">
      <h2>Trader profile memory</h2>
      <p className="muted">
        Background facts Claude uses to personalize its suggestions. They are read-only context and
        never affect order execution. Only approved memories are used.
      </p>

      {pending.length > 0 && (
        <>
          <h3 className="memory-heading">Pending review</h3>
          {pending.map(renderMemory)}
        </>
      )}

      <h3 className="memory-heading">Active</h3>
      {active.length === 0 ? <p className="muted">No active memories.</p> : active.map(renderMemory)}

      {inactive.length > 0 && (
        <>
          <h3 className="memory-heading">Inactive</h3>
          {inactive.map(renderMemory)}
        </>
      )}

      <button onClick={() => void handleDistill()} disabled={busy}>
        {busy ? "Distilling..." : "Distill lessons from history"}
      </button>
      {message && <p className="success-text">{message}</p>}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
