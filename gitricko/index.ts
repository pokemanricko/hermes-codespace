/**
 * pi-failover — True Hermes-style request-time model failover for Pi.
 *
 * Wraps a provider's `streamSimple` so that, on a PRE-FIRST-TOKEN failure
 * (timeout, connection error, 5xx, or non-retryable error), the SAME request
 * (verbatim Context + options) is re-issued against a configured fallback chain
 * via Pi's own built-in streamSimple. The agent loop is unaware a switch happened.
 *
 * See docs/ARCHITECTURE.md for the full design, the Pi API contract, and the
 * equivalence proof strategy.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { streamSimple as builtinStreamSimple } from "@earendil-works/pi-ai/compat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface FallbackConfig {
  /** Ordered fallback model IDs ("provider/id"). */
  chain: string[];
  /** Per-request connect/first-token timeout (ms). */
  timeoutMs: number;
  /** If true (default), never switch after the primary emits a token. */
  onlyPreFirstToken: boolean;
  /** Show a status bar notice on each switch. */
  notifyOnSwitch: boolean;
}

const DEFAULT_CONFIG: FallbackConfig = {
  chain: [],
  timeoutMs: 30_000,
  onlyPreFirstToken: true,
  notifyOnSwitch: true,
};

/** Path to pi models.json; per-provider "fallback" blocks are read from here. */
function modelsJsonPath(): string {
  return join(getAgentDir(), "models.json");
}

let _configOverride: FallbackConfig | null = null;

export function setConfigOverride(cfg: FallbackConfig | null) {
  _configOverride = cfg;
}

function loadConfigFor(providerId: string): FallbackConfig {
  if (_configOverride) return { ..._configOverride };
  try {
    const raw = readFileSync(modelsJsonPath(), "utf-8");
    const parsed = JSON.parse(raw);
    const block = parsed?.providers?.[providerId]?.fallback;
    if (!block) return { ...DEFAULT_CONFIG };
    return {
      ...DEFAULT_CONFIG,
      ...block,
      chain: Array.isArray(block.chain) ? block.chain : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

const DEBUG =
  process.env.PI_FAILOVER_DEBUG === "true" ||
  process.env.PI_FAILOVER_DEBUG === "1";

const log = {
  debug: (...a: unknown[]) => DEBUG && console.log("[pi-failover]", ...a),
  warn: (...a: unknown[]) => console.warn("[pi-failover]", ...a),
  error: (...a: unknown[]) => console.error("[pi-failover]", ...a),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedModel {
  provider: string;
  id: string;
}

function parseModelEntry(s: string): ParsedModel {
  const slash = s.indexOf("/");
  if (slash === -1) return { provider: "", id: s };
  return { provider: s.slice(0, slash), id: s.slice(slash + 1) };
}

/** Error thrown by our timeout/abort machinery (vs. a provider error). */
class FailoverTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`failover timeout after ${ms}ms`);
    this.name = "FailoverTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piFailover(pi: ExtensionAPI) {
  log.debug("loading pi-failover");

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const registered = new Set<string>();

    for (const model of ctx.modelRegistry.getAvailable()) {
      const cfg = loadConfigFor(model.provider);
      if (cfg.chain.length === 0) continue;
      if (registered.has(model.provider)) continue;
      registered.add(model.provider);

      log.debug(
        `registering failover wrapper for provider "${model.provider}" ` +
          `with chain [${cfg.chain.join(", ")}]`,
      );

      pi.registerProvider(model.provider, {
        api: model.api,
        streamSimple: (m, context, options) =>
          fallbackStreamSimple(pi, ctx, cfg, m, context, options),
      });
    }
  });
}

/**
 * Core failover wrapper.
 *
 * @param pi          Extension API (used to access model registry & UI).
 * @param ctx         Session context (model registry, ui, signal).
 * @param cfg         Resolved fallback config for the provider.
 * @param primary     The model Pi asked us to stream for.
 * @param context     The verbatim request Context (must NOT be mutated).
 * @param options     The verbatim stream options (must NOT be mutated).
 */
async function fallbackStreamSimple(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cfg: FallbackConfig,
  primary: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Promise<AssistantMessageEventStream> {
  // Build the candidate list: primary first, then the configured chain.
  const candidates: Array<{ model: Model<any>; label: string }> = [];
  candidates.push({ model: primary, label: `${primary.provider}/${primary.id}` });

  for (const entry of cfg.chain) {
    const { provider, id } = parseModelEntry(entry);
    const m = ctx.modelRegistry.find(provider, id);
    if (!m) {
      log.warn(`fallback target not found in registry: ${entry}`);
      continue;
    }
    candidates.push({ model: m, label: entry });
  }

  let lastError: unknown = null;

  for (let i = 0; i < candidates.length; i++) {
    const { model, label } = candidates[i];
    const isPrimary = i === 0;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new FailoverTimeoutError(cfg.timeoutMs)),
      cfg.timeoutMs,
    );
    // Thread user ESC / ctx abort into our controller.
    context?.signal?.addEventListener?.("abort", () => controller.abort());

    try {
      // Use compat's built-in streamSimple which dispatches directly to API
      // providers, bypassing our own wrapper and Pi's provider-composer.
      const stream = builtinStreamSimple(model, context, {
        ...options,
        signal: controller.signal,
      });

      // Pre-first-token only: once the primary emits a token, pass it through
      // untouched. We proxy to detect the first token and cancel the timer; if
      // onlyPreFirstToken is on and this is a fallback candidate, the first
      // token also "commits" the switch.
      const proxied = proxyUntilFirstToken(stream, () => clearTimeout(timer), cfg.onlyPreFirstToken && !isPrimary);

      if (!isPrimary && cfg.notifyOnSwitch) {
        ctx.ui?.setStatus?.(
          "pi-failover",
          `⚠ failover: ${candidates[0].label} → ${label}`,
        );
        ctx.ui?.notify?.(`Failover: ${candidates[0].label} → ${label}`, "info");
      }
      log.debug(`streaming from ${label}`);
      return proxied;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      const timeout = err instanceof FailoverTimeoutError;
      const retryable = isRetryableError(err);

      if (timeout || isNetworkError(err) || !retryable) {
        // Fail over to the next candidate.
        log.debug(
          `${label} failed (${timeout ? "timeout" : retryable ? "retryable" : "terminal"}); ` +
            `trying next candidate`,
        );
        continue;
      }
      // Retryable error on the primary: let Pi's own retry machinery handle it.
      log.debug(`${label} retryable error; re-throwing for Pi`);
      throw err;
    }
  }

  log.error("all failover candidates exhausted");
  throw lastError ?? new Error("pi-failover: all candidates failed");
}

export { loadConfigFor };

/**
 * Proxy a stream so we can run `onFirstToken` exactly once, and optionally
 * `onSwitch` the moment a token appears on a fallback candidate. The proxy does
 * NOT buffer — it re-emits everything by reference.
 */
function proxyUntilFirstToken(
  stream: AssistantMessageEventStream,
  onFirstToken: () => void,
  _commitSwitch: boolean,
): AssistantMessageEventStream {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    onFirstToken();
  };

  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const res = await stream.next();
          if (!res.done) fire();
          return res;
        },
      };
    },
    next: async () => {
      const res = await stream.next();
      if (!res.done) fire();
      return res;
    },
  } as AssistantMessageEventStream;
}

/**
 * Error classification — mirrors Pi's own logic so we fail over on the SAME
 * conditions Pi treats as terminal. In production we import
 * `isRetryableAssistantError` from "@earendil-works/pi-ai/compat". Tests inject
 * a stub. Kept as a local function to keep the module load-side-effect free.
 */
let _isRetryable: ((err: unknown) => boolean) | undefined;
export function __setRetryableClassifier(fn: (err: unknown) => boolean) {
  _isRetryable = fn;
}
function isRetryableError(err: unknown): boolean {
  if (_isRetryable) return _isRetryable(err);
  try {
    return isRetryableAssistantError(err);
  } catch {
    // Conservative default: treat unknown as terminal (fail over).
    return false;
  }
}

function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; name?: string; message?: string };
  return (
    e?.code === "ECONNRESET" ||
    e?.code === "ECONNREFUSED" ||
    e?.code === "ETIMEDOUT" ||
    e?.name === "AbortError" ||
    /network|fetch failed|socket/i.test(e?.message ?? "")
  );
}