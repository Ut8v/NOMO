/**
 * Trader profile memory types. Memories are read-only background about the
 * user; they shape how Claude proposes, and never touch execution.
 */

export type MemorySource = "conversation" | "distilled";
export type MemoryStatus = "approved" | "pending";

export interface MemoryView {
  id: string;
  content: string;
  source: MemorySource;
  status: MemoryStatus;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
