import type { PrimeChild } from "../subagents/children.js";
import { useSubagentsRoster, type RosterStatus } from "./use-subagents-roster.js";

/**
 * The Subagents panel (bbpa-ggf.9): the prime subagents of this thread, with
 * status, model and token count, live from the daemon's roster. Read-only on
 * purpose — steering and stopping a subagent is bbpa-ggf.10 — so the only
 * interaction here is reading.
 *
 * Presentation is deliberately self-contained Tailwind (the plugin build
 * scopes utilities to this plugin), with mid-tone colors that hold on both
 * light and dark chrome.
 */

export function SubagentsPanel({ threadId }: { threadId: string }) {
  const status = useSubagentsRoster(threadId);
  return (
    <div
      className="flex min-w-0 flex-col gap-3 text-sm"
      data-testid="subagents-panel"
    >
      <PanelBody status={status} />
    </div>
  );
}

function PanelBody({ status }: { status: RosterStatus }) {
  if (status.kind === "loading") {
    return (
      <p className="text-[13px] text-zinc-500" role="status">
        Reading the subagent roster…
      </p>
    );
  }
  if (status.kind === "unavailable") {
    return (
      <p
        className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-600 dark:text-amber-400"
        role="alert"
      >
        {status.message}
      </p>
    );
  }
  if (status.children.length === 0) {
    return (
      <p className="text-[13px] text-zinc-500">
        No subagents for this thread. prime-agent spawns them from its Python
        tooling (<code>rlm(…)</code>); they appear here while they run and stay
        listed until the daemon retires them.
      </p>
    );
  }
  return <RosterList roster={status.children} />;
}

function RosterList({ roster }: { roster: readonly PrimeChild[] }) {
  const ordered = [...roster].sort(
    (left, right) => Number(isLive(right)) - Number(isLive(left)),
  );
  const live = ordered.filter(isLive).length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-zinc-500">
        <span>Subagents</span>
        <span>
          {ordered.length} total
          {live > 0 ? ` · ${live} live` : ""}
        </span>
      </div>
      <ul className="flex min-w-0 flex-col gap-2">
        {ordered.map((child) => (
          <ChildRow key={child.id} child={child} />
        ))}
      </ul>
    </div>
  );
}

function ChildRow({ child }: { child: PrimeChild }) {
  const detail = childDetail(child);
  const live = isLive(child);
  return (
    <li className="min-w-0 rounded-md border border-zinc-500/20 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${statusDotClass(child.status)}`}
        />
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={child.label}
        >
          {child.label}
        </span>
        <span
          className={`shrink-0 text-[11px] uppercase tracking-wide ${statusTextClass(child.status)}`}
        >
          {child.status}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-zinc-500">
        <span className="truncate" title={child.model ?? undefined}>
          {child.model ?? "model unknown"}
        </span>
        <span>{formatTokens(child.tokenCount)}</span>
        {child.toolUseCount === undefined ? null : (
          <span>
            {child.toolUseCount}{" "}
            {child.toolUseCount === 1 ? "tool use" : "tool uses"}
          </span>
        )}
        {child.durationMs === undefined ? null : (
          <span>{formatDuration(child.durationMs)}</span>
        )}
      </div>
      {live && child.activity !== undefined ? (
        <div className="mt-1 truncate text-[12px] text-sky-600 dark:text-sky-400">
          {activityLine(child)}
        </div>
      ) : null}
      {detail !== undefined ? (
        <p
          className="mt-1 line-clamp-3 text-[12px] text-zinc-600 dark:text-zinc-400"
          title={detail}
        >
          {detail}
        </p>
      ) : null}
    </li>
  );
}

function isLive(child: PrimeChild): boolean {
  return child.status === "queued" || child.status === "running";
}

function childDetail(child: PrimeChild): string | undefined {
  const detail = (
    child.status === "error"
      ? (child.error ?? child.recap ?? child.answerPreview)
      : (child.recap ?? child.answerPreview ?? child.error)
  )?.trim();
  return detail !== undefined && detail.length > 0 ? detail : undefined;
}

function activityLine(child: PrimeChild): string {
  const tool = child.activity?.toolName ?? "";
  if (child.activity?.kind === "executing") {
    return tool.length > 0 ? `executing ${tool}` : "executing";
  }
  return child.activity?.kind ?? "working";
}

// A status prime 0.7.3 does not report renders like a queued one: a future
// prime must not blank the panel.
function statusDotClass(status: string): string {
  if (status === "running") {
    return "bg-sky-500";
  }
  if (status === "done") {
    return "bg-emerald-500";
  }
  if (status === "error") {
    return "bg-rose-500";
  }
  return "bg-zinc-400";
}

function statusTextClass(status: string): string {
  if (status === "running") {
    return "text-sky-600 dark:text-sky-400";
  }
  if (status === "done") {
    return "text-emerald-600 dark:text-emerald-400";
  }
  if (status === "error") {
    return "text-rose-600 dark:text-rose-400";
  }
  return "text-zinc-500";
}

function formatTokens(tokenCount: number | undefined): string {
  return tokenCount === undefined
    ? "— tokens"
    : `${tokenCount.toLocaleString("en-US")} tokens`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }
  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}
