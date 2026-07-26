/**
 * The typed contract every research specialist must return. Specialists never
 * emit prose: they call their emit_findings tool with an object of this shape,
 * validated at the boundary so synthesis always consumes structured data.
 */

export type SignalDirection = "bullish" | "bearish" | "neutral";

export interface Signal {
  /** Short label, e.g. "RSI(14)", "revenue growth YoY", "insider buying". */
  name: string;
  /** The observed value as text or a number rendered to text. Deterministic. */
  value: string;
  direction: SignalDirection;
  /** Confidence in the signal, 0 to 1. */
  confidence: number;
}

export interface Findings {
  /** Symbol the findings concern, or a label like PORTFOLIO for account-wide work. */
  ticker: string;
  signals: Signal[];
  /** Tool names or references the signals were derived from. */
  sources: string[];
}

const DIRECTIONS: readonly SignalDirection[] = ["bullish", "bearish", "neutral"];
const MAX_SIGNALS = 24;
const MAX_SOURCES = 24;

export type FindingsParseResult =
  | { ok: true; findings: Findings }
  | { ok: false; error: string };

function parseSignal(raw: unknown, index: number): Signal {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`signals[${index}] must be an object.`);
  }
  const signal = raw as Record<string, unknown>;
  const name = typeof signal.name === "string" ? signal.name.trim() : "";
  if (!name) throw new Error(`signals[${index}].name is required.`);

  // Numbers are accepted and rendered to text so the value stays deterministic
  // and the model cannot smuggle a computation into a structured field.
  const rawValue = signal.value;
  const value =
    typeof rawValue === "string"
      ? rawValue.trim()
      : typeof rawValue === "number" && Number.isFinite(rawValue)
        ? String(rawValue)
        : "";
  if (!value) throw new Error(`signals[${index}].value is required.`);

  if (!DIRECTIONS.includes(signal.direction as SignalDirection)) {
    throw new Error(`signals[${index}].direction must be one of: ${DIRECTIONS.join(", ")}.`);
  }

  const confidence = typeof signal.confidence === "number" ? signal.confidence : Number.NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`signals[${index}].confidence must be a number between 0 and 1.`);
  }

  return { name, value, direction: signal.direction as SignalDirection, confidence };
}

/**
 * Validates untrusted findings from a specialist. Returns a result rather than
 * throwing so the sub-loop can hand the error text back for one retry.
 */
export function parseFindings(input: unknown): FindingsParseResult {
  try {
    if (typeof input !== "object" || input === null) {
      throw new Error("findings must be an object.");
    }
    const raw = input as Record<string, unknown>;
    const ticker = typeof raw.ticker === "string" ? raw.ticker.trim().toUpperCase() : "";
    if (!ticker || ticker.length > 15) {
      throw new Error("ticker must be a symbol or label, 1 to 15 characters.");
    }

    if (!Array.isArray(raw.signals)) throw new Error("signals must be an array.");
    if (raw.signals.length > MAX_SIGNALS) {
      throw new Error(`signals may not exceed ${MAX_SIGNALS} entries.`);
    }
    const signals = raw.signals.map((entry, i) => parseSignal(entry, i));

    const sourcesRaw = raw.sources ?? [];
    if (!Array.isArray(sourcesRaw)) throw new Error("sources must be an array of strings.");
    const sources = sourcesRaw
      .slice(0, MAX_SOURCES)
      .map((source) => (typeof source === "string" ? source.trim() : ""))
      .filter((source) => source.length > 0);

    return { ok: true, findings: { ticker, signals, sources } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid findings object." };
  }
}
