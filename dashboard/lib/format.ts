export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("nb-NO", {
    timeZone: "Europe/Oslo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const STATUS_LABELS: Record<string, string> = {
  routing: "Rutes",
  assigned: "Tildelt",
  partially_assigned: "Delvis tildelt",
  escalated: "Eskalert",
  cancelled: "Kansellert",
  pending: "I kø",
  offered: "Tilbudt",
  accepted: "Godtatt",
  declined: "Avslått",
  declined_stock: "Avslått (lager)",
  expired: "Utløpt",
  ok: "OK",
  error: "Feil",
  running: "Kjører",
};

export function label(s: string | null | undefined): string {
  return s ? STATUS_LABELS[s] ?? s : "–";
}
