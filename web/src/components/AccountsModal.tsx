import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { api, type Account, type AccountInput, type UsagePayload, type UsageWindow } from "../lib/api.ts";
import type { DesktopInstance } from "../../../shared/types.ts";

// Human reset label: "in 1h 44m" when soon, else "Wed 3:00 PM".
function resetLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "now";
  if (ms < 24 * 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h >= 1 ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  const day = d.toLocaleDateString([], { weekday: "short" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

function usedColor(used: number): string {
  if (used >= 85) return "var(--error)";
  if (used >= 60) return "var(--warning)";
  return "var(--success)";
}

function Meter({ label, w }: { label: string; w: UsageWindow }) {
  const color = usedColor(w.utilization);
  return (
    <div className="flex items-center gap-2" title={`${label}: ${w.utilization}% used — resets ${resetLabel(w.resets_at)}`}>
      <span className="text-[9px] uppercase tracking-[0.14em] t-dim2 w-[70px] shrink-0">{label}</span>
      <div className="h-1.5 flex-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${w.utilization}%`, background: color }} />
      </div>
      <span className="text-[11px] font-semibold tabular-nums w-8 text-right" style={{ color }}>{w.utilization}%</span>
      <span className="text-[10px] t-dim2 w-[86px] text-right shrink-0">{resetLabel(w.resets_at)}</span>
    </div>
  );
}

// Login status derived from the account's usage reading — the single most
// useful "can the harness use this account right now" signal.
function statusOf(u?: UsagePayload): { text: string; color: string } {
  if (!u) return { text: "no reading", color: "var(--text4)" };
  if (u.available) return { text: "connected", color: "var(--success)" };
  switch (u.reason) {
    case "no_credentials": return { text: "not logged in", color: "var(--text4)" };
    case "unauthorized": return { text: "re-login needed", color: "var(--warning)" };
    case "rate_limited": return { text: "rate-limited", color: "var(--warning)" };
    default: return { text: "unavailable", color: "var(--error)" };
  }
}

function toInput(a: Account): AccountInput {
  return {
    id: a.id,
    label: a.label === a.id ? "" : a.label,
    plan_tier: a.planTier ?? "",
    claude_config_dir: a.usesDefaultDir ? "" : a.configDir,
    account_paths: a.accountPaths,
    desktop_instance: a.desktopInstance ?? "",
  };
}

function AccountCard({ a, u, onEdit, onDelete }: { a: Account; u?: UsagePayload; onEdit: () => void; onDelete: () => void }) {
  const status = statusOf(u);
  return (
    <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: "color-mix(in srgb, var(--bg3) 34%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
      <div className="flex items-center gap-2.5">
        <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>{a.label}</span>
        <span className="text-[11px] t-dim2 tabular-nums">{a.id}</span>
        {a.planTier && <span className="chip" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", borderColor: "color-mix(in srgb, var(--primary) 40%, transparent)" }}>{a.planTier}</span>}
        {a.synthesized && <span className="chip t-dim2" style={{ borderColor: "color-mix(in srgb, var(--border) 50%, transparent)" }}>default</span>}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium" style={{ color: status.color }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.color }} />{status.text}
        </span>
      </div>

      {u?.available ? (
        <div className="flex flex-col gap-1.5">
          {u.five_hour && <Meter label="5h window" w={u.five_hour} />}
          {u.seven_day && <Meter label="weekly" w={u.seven_day} />}
          {u.seven_day_opus && <Meter label="weekly · opus" w={u.seven_day_opus} />}
          {u.seven_day_sonnet && <Meter label="weekly · sonnet" w={u.seven_day_sonnet} />}
        </div>
      ) : (
        <div className="text-[11px] t-dim2">
          {u?.reason === "unauthorized"
            ? <>Access token expired — run <code className="px-1 rounded" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }}>{`CLAUDE_CONFIG_DIR=${a.configDir} claude -p hi`}</code> to refresh.</>
            : u?.reason === "no_credentials"
            ? <>No credentials at <code className="px-1 rounded" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }}>{a.credentialsPath}</code> — log in with <code className="px-1 rounded" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }}>{`CLAUDE_CONFIG_DIR=${a.configDir} claude login`}</code>.</>
            : (u?.error ?? "meter unavailable")}
        </div>
      )}

      <div className="flex items-center gap-3 text-[10px] t-dim2">
        <span className="truncate" title={a.configDir}>{a.usesDefaultDir ? "default login (~/.claude)" : a.configDir}</span>
        {a.accountPaths.length > 0 && <span className="truncate" title={a.accountPaths.join(", ")}>· {a.accountPaths.length} path{a.accountPaths.length === 1 ? "" : "s"}</span>}
        {a.desktopInstance && <span>· desktop: {a.desktopInstance}</span>}
        <span className="ml-auto flex items-center gap-2">
          <button onClick={onEdit} className="hover:opacity-80" style={{ color: "var(--primary-hover)" }}>edit</button>
          {!a.synthesized && <button onClick={onDelete} className="hover:opacity-80" style={{ color: "var(--error)" }}>remove</button>}
        </span>
      </div>
    </div>
  );
}

const inputStyle = { background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", color: "var(--text)" };

function EditForm({ initial, onSave, onCancel, error }: { initial: AccountInput; onSave: (a: AccountInput) => void; onCancel: () => void; error: string | null }) {
  const [f, setF] = useState<AccountInput>(initial);
  const set = (k: keyof AccountInput, v: string) => setF((p) => ({ ...p, [k]: v }));
  const pathsText = (f.account_paths ?? []).join("\n");
  return (
    <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: "color-mix(in srgb, var(--primary) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-[11px] t-dim2">id
          <input value={f.id} onChange={(e) => set("id", e.target.value)} placeholder="work" className="px-2.5 py-1.5 rounded-lg text-[13px]" style={inputStyle} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] t-dim2">label
          <input value={f.label ?? ""} onChange={(e) => set("label", e.target.value)} placeholder="Work Max" className="px-2.5 py-1.5 rounded-lg text-[13px]" style={inputStyle} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] t-dim2">plan tier
          <input value={f.plan_tier ?? ""} onChange={(e) => set("plan_tier", e.target.value)} placeholder="max20x" className="px-2.5 py-1.5 rounded-lg text-[13px]" style={inputStyle} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] t-dim2">desktop instance
          <input value={f.desktop_instance ?? ""} onChange={(e) => set("desktop_instance", e.target.value)} placeholder="(optional)" className="px-2.5 py-1.5 rounded-lg text-[13px]" style={inputStyle} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[11px] t-dim2">CLAUDE_CONFIG_DIR <span className="t-dim2">(blank = default ~/.claude login)</span>
        <input value={f.claude_config_dir ?? ""} onChange={(e) => set("claude_config_dir", e.target.value)} placeholder="~/.claude-accounts/work" className="px-2.5 py-1.5 rounded-lg text-[13px] font-mono" style={inputStyle} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] t-dim2">account paths <span className="t-dim2">(one cwd prefix per line — attributes those repos to this account)</span>
        <textarea value={pathsText} onChange={(e) => setF((p) => ({ ...p, account_paths: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) }))} rows={2} placeholder="~/Github/work" className="px-2.5 py-1.5 rounded-lg text-[13px] font-mono resize-y" style={inputStyle} />
      </label>
      {error && <div className="text-[11px]" style={{ color: "var(--error)" }}>{error}</div>}
      <div className="flex items-center gap-2 justify-end">
        <button onClick={onCancel} className="text-[12px] px-3 py-1.5 rounded-lg t-dim2 hover:opacity-80" style={{ border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>cancel</button>
        <button onClick={() => onSave(f)} className="text-[12px] px-3 py-1.5 rounded-lg font-medium hover:opacity-90" style={{ color: "white", background: "var(--primary)" }}>save account</button>
      </div>
    </div>
  );
}

function InstanceRow({ inst, onLaunch, onStop }: { inst: DesktopInstance; onLaunch: (n: string) => void; onStop: (n: string) => void }) {
  const color = inst.running ? "var(--success)" : "var(--text4)";
  return (
    <div className="rounded-xl px-3 py-2.5 flex items-center gap-2.5" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: color }} />
      <span className="text-[13px] font-medium" style={{ color: "var(--text)" }}>{inst.name}</span>
      {inst.isDefault && <span className="chip t-dim2" style={{ borderColor: "color-mix(in srgb, var(--border) 50%, transparent)" }}>default</span>}
      {inst.account && <span className="text-[10px] t-dim2">→ {inst.account}</span>}
      <span className="text-[10px] t-dim2 truncate hidden sm:block" title={inst.dataDir}>{inst.dataDir}</span>
      <span className="ml-auto flex items-center gap-2 shrink-0">
        <span className="text-[11px]" style={{ color }}>{inst.running ? `running · ${inst.pids.length}` : "stopped"}</span>
        {inst.manageable && (inst.running
          ? <button onClick={() => onStop(inst.name)} className="text-[11px] hover:opacity-80" style={{ color: "var(--error)" }}>stop</button>
          : <button onClick={() => onLaunch(inst.name)} className="text-[11px] hover:opacity-80" style={{ color: "var(--primary-hover)" }}>launch</button>)}
      </span>
    </div>
  );
}

export function AccountsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<Record<string, UsagePayload>>({});
  const [instances, setInstances] = useState<DesktopInstance[]>([]);
  const [editing, setEditing] = useState<AccountInput | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadInstances = useCallback(() => { api.instances().then((r) => setInstances(r.instances)).catch(() => {}); }, []);
  const launch = async (name: string) => { await api.launchInstance(name); setTimeout(loadInstances, 1500); };
  const stop = async (name: string) => { await api.stopInstance(name); setTimeout(loadInstances, 1000); };
  const loadAccounts = useCallback(() => { api.accounts().then((r) => setAccounts(r.accounts)).catch(() => {}); }, []);
  const loadUsage = useCallback(() => {
    api.usageAll().then((r) => {
      const m: Record<string, UsagePayload> = {};
      for (const u of r.usage) if (u.account) m[u.account] = u;
      setUsage(m);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    loadAccounts();
    loadUsage();
    loadInstances();
    const id = setInterval(() => { loadUsage(); loadInstances(); }, 30_000);
    return () => clearInterval(id);
  }, [open, loadAccounts, loadUsage, loadInstances]);

  const save = async (input: AccountInput) => {
    const r = await api.saveAccount(input);
    if (!r.ok) { setErr(r.error ?? "save failed"); return; }
    setEditing(null); setErr(null); loadAccounts(); loadUsage();
  };
  const del = async (id: string) => {
    const r = await api.deleteAccount(id);
    if (r.ok) { loadAccounts(); loadUsage(); }
  };

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
                <div className="w-[min(720px,96vw)]" onClick={(e) => e.stopPropagation()}>
                  <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between mb-4 px-1">
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-[17px] font-semibold" style={{ color: "var(--text)" }}>Accounts</span>
                      <span className="text-[12px] t-dim2">{accounts.length} configured</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {!editing && <button onClick={() => { setErr(null); setEditing({ id: "", account_paths: [] }); }} className="text-[12px] px-3 py-1.5 rounded-lg font-medium hover:opacity-90" style={{ color: "white", background: "var(--primary)" }}>+ add account</button>}
                      <CloseButton onClick={onClose} />
                    </div>
                  </motion.div>

                  <div className="flex flex-col gap-3">
                    {editing && <EditForm initial={editing} onSave={save} onCancel={() => { setEditing(null); setErr(null); }} error={err} />}
                    {accounts.map((a) => (
                      <AccountCard key={a.id} a={a} u={usage[a.id]} onEdit={() => { setErr(null); setEditing(toInput(a)); }} onDelete={() => del(a.id)} />
                    ))}
                    {!accounts.length && !editing && <div className="text-[12px] t-dim2 px-1">No accounts yet.</div>}

                    {instances.length > 0 && (
                      <div className="flex flex-col gap-1.5 mt-2">
                        <div className="text-[10px] uppercase tracking-[0.14em] t-dim2 px-1">Desktop instances</div>
                        {instances.map((i) => <InstanceRow key={i.name} inst={i} onLaunch={launch} onStop={stop} />)}
                        <div className="text-[10px] t-dim2 px-1">Link an instance to an account by setting its “desktop instance” in the account editor.</div>
                      </div>
                    )}
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
