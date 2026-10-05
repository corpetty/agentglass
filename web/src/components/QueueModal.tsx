import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { api, type Account } from "../lib/api.ts";
import type { Job, JobStatus, JobInput } from "../../../shared/types.ts";

const STATUS_ORDER: JobStatus[] = ["running", "queued", "blocked", "done", "failed", "expired", "cancelled"];
const STATUS_COLOR: Record<JobStatus, string> = {
  running: "var(--primary)",
  queued: "var(--warning)",
  blocked: "var(--text4)",
  done: "var(--success)",
  failed: "var(--error)",
  expired: "var(--text4)",
  cancelled: "var(--text4)",
};

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function StatusChip({ status }: { status: JobStatus }) {
  const c = STATUS_COLOR[status];
  return (
    <span className="chip shrink-0" style={{ color: c, background: `color-mix(in srgb, ${c} 15%, transparent)`, borderColor: `color-mix(in srgb, ${c} 40%, transparent)` }}>
      {status}
    </span>
  );
}

const inputStyle = { background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", color: "var(--text)" };

function JobRow({ job, onCancel, onOpenSession }: { job: Job; onCancel: (id: string) => void; onOpenSession?: (id: string) => void }) {
  const canCancel = job.status === "queued" || job.status === "blocked";
  return (
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
      <div className="flex items-center gap-2">
        <StatusChip status={job.status} />
        <span className="text-[10px] t-dim2 tabular-nums shrink-0" title="priority">P{job.priority}</span>
        <span className="text-[13px] truncate" style={{ color: "var(--text)" }} title={job.prompt}>{job.prompt}</span>
        <span className="ml-auto text-[10px] t-dim2 shrink-0">{ago(job.updated_at)}</span>
      </div>
      <div className="flex items-center gap-2.5 text-[10px] t-dim2 flex-wrap">
        <span className="truncate max-w-[220px]" title={job.cwd}>{job.cwd.split("/").slice(-1)[0] || job.cwd}</span>
        <span>· {job.account_used ?? (job.account_id === "any" ? "any account" : job.account_id)}</span>
        <span>· {job.max_turns} turns</span>
        {job.attempts > 0 && <span>· try {job.attempts}/{job.max_attempts}</span>}
        {job.result_session_id && onOpenSession && (
          <button onClick={() => onOpenSession(job.result_session_id!)} className="hover:opacity-80" style={{ color: "var(--primary-hover)" }}>open session ↗</button>
        )}
        {canCancel && <button onClick={() => onCancel(job.id)} className="ml-auto hover:opacity-80" style={{ color: "var(--error)" }}>cancel</button>}
      </div>
      {job.status === "done" && job.result_summary && (
        <div className="text-[11px] t-dim2 line-clamp-2" style={{ color: "var(--text3)" }}>{job.result_summary}</div>
      )}
      {(job.status === "failed" || job.error) && job.error && (
        <div className="text-[11px]" style={{ color: "var(--error)" }}>{job.error}</div>
      )}
    </div>
  );
}

function CreateForm({ accounts, onCreated }: { accounts: Account[]; onCreated: () => void }) {
  const [f, setF] = useState<JobInput>({ prompt: "", cwd: "", account_id: "any", priority: 50, max_turns: 20, permission_mode: "default" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof JobInput, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await api.createJob(f);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "create failed"); return; }
    setF({ prompt: "", cwd: f.cwd, account_id: f.account_id, priority: 50, max_turns: 20, permission_mode: "default" });
    onCreated();
  };
  return (
    <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: "color-mix(in srgb, var(--primary) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)" }}>
      <textarea value={f.prompt} onChange={(e) => set("prompt", e.target.value)} rows={2} placeholder="Prompt — what should the agent do?" className="px-2.5 py-1.5 rounded-lg text-[13px] resize-y" style={inputStyle} />
      <input value={f.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="Working directory (a git repo), e.g. ~/Github/agentglass" className="px-2.5 py-1.5 rounded-lg text-[13px] font-mono" style={inputStyle} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <label className="flex flex-col gap-1 text-[10px] t-dim2">account
          <select value={f.account_id} onChange={(e) => set("account_id", e.target.value)} className="px-2 py-1.5 rounded-lg text-[12px]" style={inputStyle}>
            <option value="any">any (by headroom)</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] t-dim2">priority (0–100)
          <input type="number" min={0} max={100} value={f.priority} onChange={(e) => set("priority", Number(e.target.value))} className="px-2 py-1.5 rounded-lg text-[12px]" style={inputStyle} />
        </label>
        <label className="flex flex-col gap-1 text-[10px] t-dim2">max turns
          <input type="number" min={1} max={200} value={f.max_turns} onChange={(e) => set("max_turns", Number(e.target.value))} className="px-2 py-1.5 rounded-lg text-[12px]" style={inputStyle} />
        </label>
        <label className="flex flex-col gap-1 text-[10px] t-dim2">permission
          <select value={f.permission_mode} onChange={(e) => set("permission_mode", e.target.value)} className="px-2 py-1.5 rounded-lg text-[12px]" style={inputStyle}>
            <option value="default">default (prompts)</option>
            <option value="plan">plan (no execution)</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="bypassPermissions">bypass (opt-in)</option>
          </select>
        </label>
      </div>
      {err && <div className="text-[11px]" style={{ color: "var(--error)" }}>{err}</div>}
      <div className="flex items-center justify-between">
        <span className="text-[10px] t-dim2">Runs headless under the chosen account's subscription — never metered API.</span>
        <button onClick={submit} disabled={busy} className="text-[12px] px-3 py-1.5 rounded-lg font-medium hover:opacity-90 disabled:opacity-50" style={{ color: "white", background: "var(--primary)" }}>
          {busy ? "queuing…" : "queue job"}
        </button>
      </div>
    </div>
  );
}

export function QueueModal({ open, onClose, onOpenSession }: { open: boolean; onClose: () => void; onOpenSession?: (id: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const load = useCallback(() => { api.jobs().then((r) => setJobs(r.jobs)).catch(() => {}); }, []);
  useEffect(() => {
    if (!open) return;
    load();
    api.accounts().then((r) => setAccounts(r.accounts)).catch(() => {});
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [open, load]);

  const cancel = async (id: string) => { await api.cancelJob(id); load(); };
  const byStatus = (s: JobStatus) => jobs.filter((j) => j.status === s);
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "blocked").length;

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(6,3,14,0.64)", backdropFilter: "blur(14px) saturate(1.05)", WebkitBackdropFilter: "blur(14px) saturate(1.05)" }} onClick={onClose} />
            <motion.div
              initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.99 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed inset-0 overflow-y-auto" style={{ zIndex: 10001 }} onClick={onClose}>
              <div className="min-h-full flex flex-col items-center px-4 py-6">
                <div className="w-[min(820px,96vw)]" onClick={(e) => e.stopPropagation()}>
                  <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between mb-4 px-1">
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-[17px] font-semibold" style={{ color: "var(--text)" }}>Queue</span>
                      <span className="text-[12px] t-dim2">{active} active · {jobs.length} total</span>
                    </div>
                    <CloseButton onClick={onClose} />
                  </motion.div>

                  <div className="flex flex-col gap-3">
                    <CreateForm accounts={accounts} onCreated={load} />
                    {!jobs.length && <div className="text-[12px] t-dim2 px-1 py-6 text-center">No jobs yet. Queue one above — it runs unattended when an account has headroom.</div>}
                    {STATUS_ORDER.map((status) => {
                      const rows = byStatus(status);
                      if (!rows.length) return null;
                      return (
                        <div key={status} className="flex flex-col gap-1.5">
                          <div className="text-[10px] uppercase tracking-[0.14em] px-1" style={{ color: STATUS_COLOR[status] }}>{status} · {rows.length}</div>
                          {rows.map((j) => <JobRow key={j.id} job={j} onCancel={cancel} onOpenSession={onOpenSession} />)}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
