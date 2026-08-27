import { label } from "@/lib/format";

const TONE: Record<string, string> = {
  assigned: "good",
  accepted: "good",
  ok: "good",
  escalated: "bad",
  error: "bad",
  expired: "bad",
  declined_stock: "warn",
  partially_assigned: "warn",
  routing: "info",
  offered: "info",
  running: "info",
  cancelled: "muted",
  declined: "muted",
  pending: "muted",
};

export function Badge({ status }: { status: string | null | undefined }) {
  const key = status?.startsWith("error") ? "error" : status ?? "";
  return <span className={`badge ${TONE[key] ?? "muted"}`}>{label(status)}</span>;
}
