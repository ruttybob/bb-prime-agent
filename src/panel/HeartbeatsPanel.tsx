import { useState } from "react";
import { useHeartbeats } from "./use-heartbeats.js";
import type { HeartbeatAction } from "./use-heartbeats.js";
import type { PrimeCronJob } from "../heartbeats/wire.js";

/**
 * The Heartbeats panel (bbpa-b1m.3), with the Schedules section
 * (bbpa-b1m.4): the resident session's user and agent heartbeats — schedule,
 * delivery badge, status, next run — with pause/resume/stop on each row and a
 * create form matching prime's own `/heartbeat` grammar; beneath them, the
 * session's prime-side schedules (`cron`) with add and cancel.
 *
 * The panel is pending states only: what it never does is invent a result —
 * a stopped row says so when the refreshed list says so, and a refused
 * action says so instead of going quiet. Presentation is deliberately
 * self-contained Tailwind, with mid-tone colors that hold on both light and
 * dark chrome, matching the Subagents panel.
 */

const DELIVERY_BADGE: Record<string, string> = {
  steer: "steer",
  follow_up: "follow-up",
};

function scheduleText(job: PrimeCronJob): string {
  return job.schedule?.expression ?? "(unknown schedule)";
}

function relativeTime(iso: string | undefined): string | undefined {
  if (iso === undefined) {
    return undefined;
  }
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return undefined;
  }
  const deltaMs = at - Date.now();
  const minutes = Math.round(deltaMs / 60_000);
  if (Math.abs(minutes) < 1) {
    return "now";
  }
  if (Math.abs(minutes) < 60) {
    return deltaMs > 0 ? `in ${minutes}m` : `${-minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return deltaMs > 0 ? `in ${hours}h` : `${-hours}h ago`;
}

export function HeartbeatsPanel({ threadId }: { threadId: string }) {
  const panel = useHeartbeats(threadId);
  return (
    <div
      className="flex min-w-0 flex-col gap-3 text-sm"
      data-testid="heartbeats-panel"
    >
      <PanelBody panel={panel} />
    </div>
  );
}

function PanelBody({ panel }: { panel: ReturnType<typeof useHeartbeats> }) {
  const { status } = panel;
  if (status.kind === "loading") {
    return (
      <p className="text-[13px] text-zinc-500" role="status">
        Reading the session's heartbeats…
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
  // The read's own states are not "empty": a thread with no prime session
  // yet, and a session no connected host holds, must not look like a session
  // with no heartbeats — the create forms would invite writes that cannot
  // land. Both render as copy instead of forms.
  if (status.list.state === "unknown_thread") {
    return (
      <p className="text-[13px] text-zinc-500">
        No prime-agent session for this thread yet. Start it on prime-agent and
        its heartbeats become visible here.
      </p>
    );
  }
  if (status.list.state === "unavailable") {
    return (
      <p
        className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-600 dark:text-amber-400"
        role="alert"
      >
        No connected machine holds prime-agent session {status.list.activeSessionId}. Is
        prime-agent running on the machine this thread runs on?
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">
        Heartbeats
      </p>
      {status.list.heartbeats.length === 0 ? (
        <p className="text-[13px] text-zinc-500">
          No heartbeats on this session. Create one below — it repeats the
          instruction on a schedule, delivered as a steer (or queued as a
          follow-up when the session is busy).
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {status.list.heartbeats.map((job) => (
            <HeartbeatRow key={job.id} job={job} panel={panel} />
          ))}
        </ul>
      )}
      <HeartbeatForm panel={panel} />
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">
        Schedules
      </p>
      {status.list.schedules.length === 0 ? (
        <p className="text-[13px] text-zinc-500">
          No prime-side schedules on this session. These run against the
          resident session itself — bb automations schedule separate runs
          instead (ADR-0004).
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {status.list.schedules.map((job) => (
            <ScheduleRow key={job.id} job={job} panel={panel} />
          ))}
        </ul>
      )}
      <ScheduleForm panel={panel} />
      {panel.failure !== undefined && (
        <p
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-600 dark:text-amber-400"
          role="alert"
        >
          {panel.failure}
        </p>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const live = status === "active";
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${live ? "bg-emerald-500" : "bg-zinc-400"}`}
      title={status}
      aria-label={status}
    />
  );
}

function HeartbeatRow({
  job,
  panel,
}: {
  job: PrimeCronJob;
  panel: ReturnType<typeof useHeartbeats>;
}) {
  const source =
    job.source === "rlm_heartbeat" ? "agent" : job.source === "heartbeat" ? "user" : job.source;
  const next = relativeTime(job.nextRunAt);
  const busy = panel.pending !== undefined;
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border border-zinc-500/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <StatusDot status={job.status} />
        <span className="truncate font-medium">{job.prompt ?? job.label ?? "(no instruction)"}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] uppercase tracking-wide text-zinc-500">
          <span className="rounded border border-zinc-500/40 px-1">{source}</span>
          {job.deliveryMode !== undefined && (
            <span className="rounded border border-zinc-500/40 px-1">
              {DELIVERY_BADGE[job.deliveryMode] ?? job.deliveryMode}
            </span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-zinc-500">
        <span>{scheduleText(job)}</span>
        {next !== undefined && (
          <span>
            · next run {next}
          </span>
        )}
        {typeof job.runCount === "number" && job.runCount > 0 && (
          <span>· {job.runCount} runs</span>
        )}
      </div>
      <RowActions
        job={job}
        busy={busy}
        pending={panel.pending}
        onAct={(action) => void panel.manage({ jobId: job.id, action })}
        actions={["pause", "resume", "stop"] as const}
      />
    </li>
  );
}

function ScheduleRow({
  job,
  panel,
}: {
  job: PrimeCronJob;
  panel: ReturnType<typeof useHeartbeats>;
}) {
  const next = relativeTime(job.nextRunAt);
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border border-zinc-500/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <StatusDot status={job.status} />
        <span className="truncate font-medium">{job.prompt ?? "(no prompt)"}</span>
        <span className="ml-auto text-[11px] uppercase tracking-wide text-zinc-500">
          cron
        </span>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-zinc-500">
        <span>{scheduleText(job)}</span>
        {next !== undefined && <span>· next run {next}</span>}
      </div>
      <RowActions
        job={job}
        busy={panel.pending !== undefined}
        pending={panel.pending}
        onAct={(action) => void panel.scheduleCancel({ jobId: job.id })}
        actions={["cancel"] as const}
      />
    </li>
  );
}

function RowActions<A extends HeartbeatAction>({
  job,
  busy,
  pending,
  onAct,
  actions,
}: {
  job: PrimeCronJob;
  busy: boolean;
  pending: HeartbeatAction | undefined;
  onAct: (action: A) => void;
  actions: readonly A[];
}) {
  return (
    <div className="flex items-center gap-1">
      {actions.map((action) => {
        const hidden =
          (action === "pause" && job.status !== "active") ||
          (action === "resume" && job.status !== "paused");
        if (hidden) {
          return null;
        }
        return (
          <button
            key={action}
            type="button"
            disabled={busy}
            onClick={() => onAct(action)}
            className="rounded border border-zinc-500/40 px-2 py-0.5 text-[12px] text-zinc-600 transition-colors hover:bg-zinc-500/10 disabled:cursor-wait disabled:opacity-50 dark:text-zinc-300"
          >
            {pending === action ? `${action}…` : action}
          </button>
        );
      })}
    </div>
  );
}

function HeartbeatForm({ panel }: { panel: ReturnType<typeof useHeartbeats> }) {
  const [schedule, setSchedule] = useState("every 30m");
  const [prompt, setPrompt] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"steer" | "follow_up">("steer");
  const busy = panel.pending !== undefined;
  return (
    <form
      className="flex min-w-0 flex-col gap-2 rounded-md border border-zinc-500/30 px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (schedule.trim() === "" || prompt.trim() === "") {
          return;
        }
        void panel.set({ schedule: schedule.trim(), prompt: prompt.trim(), deliveryMode });
      }}
    >
      <p className="text-[12px] text-zinc-500">
        New heartbeat — schedule as prime parses it (<code>every 30m</code>,{" "}
        <code>cron expr</code>, or a fixed time).
      </p>
      <input
        value={schedule}
        onChange={(event) => setSchedule(event.target.value)}
        placeholder="every 30m"
        aria-label="Heartbeat schedule"
        className="min-w-0 rounded border border-zinc-500/40 bg-transparent px-2 py-1 text-[13px]"
      />
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Instruction to deliver on every beat…"
        aria-label="Heartbeat instruction"
        rows={2}
        className="min-w-0 rounded border border-zinc-500/40 bg-transparent px-2 py-1 text-[13px]"
      />
      <div className="flex items-center gap-2">
        <select
          value={deliveryMode}
          onChange={(event) =>
            setDeliveryMode(event.target.value === "follow_up" ? "follow_up" : "steer")
          }
          aria-label="Delivery mode"
          className="rounded border border-zinc-500/40 bg-transparent px-2 py-1 text-[12px]"
        >
          <option value="steer">steer</option>
          <option value="follow_up">follow-up</option>
        </select>
        <button
          type="submit"
          disabled={busy || schedule.trim() === "" || prompt.trim() === ""}
          className="rounded border border-zinc-500/40 px-2 py-1 text-[12px] transition-colors hover:bg-zinc-500/10 disabled:cursor-wait disabled:opacity-50"
        >
          {panel.pending === "set" ? "setting…" : "set heartbeat"}
        </button>
      </div>
    </form>
  );
}

function ScheduleForm({ panel }: { panel: ReturnType<typeof useHeartbeats> }) {
  const [schedule, setSchedule] = useState("");
  const [prompt, setPrompt] = useState("");
  const busy = panel.pending !== undefined;
  return (
    <form
      className="flex min-w-0 flex-col gap-2 rounded-md border border-zinc-500/30 px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (schedule.trim() === "" || prompt.trim() === "") {
          return;
        }
        void panel.scheduleAdd({ schedule: schedule.trim(), prompt: prompt.trim() });
      }}
    >
      <p className="text-[12px] text-zinc-500">
        New schedule — a prompt delivered to this session on a schedule.
      </p>
      <input
        value={schedule}
        onChange={(event) => setSchedule(event.target.value)}
        placeholder="every 10m"
        aria-label="Schedule"
        className="min-w-0 rounded border border-zinc-500/40 bg-transparent px-2 py-1 text-[13px]"
      />
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Prompt to run…"
        aria-label="Schedule prompt"
        rows={2}
        className="min-w-0 rounded border border-zinc-500/40 bg-transparent px-2 py-1 text-[13px]"
      />
      <button
        type="submit"
        disabled={busy || schedule.trim() === "" || prompt.trim() === ""}
        className="self-start rounded border border-zinc-500/40 px-2 py-1 text-[12px] transition-colors hover:bg-zinc-500/10 disabled:cursor-wait disabled:opacity-50"
      >
        {panel.pending === "add" ? "adding…" : "add schedule"}
      </button>
    </form>
  );
}
