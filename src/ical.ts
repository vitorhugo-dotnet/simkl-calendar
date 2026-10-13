import type { CalendarEvent } from "./domain";
const clean = (value: string) =>
  value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
const text = (value: string) =>
  clean(value)
    .replaceAll("\\", "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
function fold(line: string): string {
  let current = "";
  let size = 0;
  const lines: string[] = [];
  for (const char of line) {
    const bytes = new TextEncoder().encode(char).length;
    if (size + bytes > 75) {
      lines.push(current);
      current = " ";
      size = 1;
    }
    current += char;
    size += bytes;
  }
  lines.push(current);
  return lines.join("\r\n");
}
const date = (value: string) => value.replace(/[-:]/g, "");
export function serializeCalendar(
  events: CalendarEvent[],
  modifiedAt: number,
): string {
  const stamp = new Date(modifiedAt)
    .toISOString()
    .replace(".000", "")
    .replace(/[-:]/g, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Simkl Calendar Sync//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${text(e.uid)}`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      `DTSTART${e.allDay ? ";VALUE=DATE" : ""}:${date(e.start)}`,
    );
    if (e.end)
      lines.push(`DTEND${e.allDay ? ";VALUE=DATE" : ""}:${date(e.end)}`);
    lines.push(
      `SUMMARY:${text(e.summary)}`,
      `DESCRIPTION:${text(e.description)}`,
      `URL:${clean(e.url).replace(/[\r\n]/g, "")}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
