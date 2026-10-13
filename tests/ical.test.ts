import { expect, it } from "vitest";
import ICAL from "ical.js";
import { serializeCalendar } from "../src/ical";
import { selectEvents } from "../src/calendar";
import type { CalendarEvent } from "../src/domain";
const event: CalendarEvent = {
  uid: "tv-1-0-1@simkl-calendar",
  start: "2026-10-20T12:00:00Z",
  end: "2026-10-20T12:25:00Z",
  allDay: false,
  summary: "A,;\\\n🎬".repeat(40),
  description: "one\ntwo,;\\",
  url: "https://simkl.com/tv/1/",
};
it("independently parses UTC, duration, escaped text and UTF-8 folding", () => {
  const text = serializeCalendar([event], Date.parse("2026-10-13T12:00:00Z"));
  const calendar = new ICAL.Component(ICAL.parse(text));
  const e = new ICAL.Event(calendar.getFirstSubcomponent("vevent")!);
  expect(e.summary).toBe(event.summary);
  expect(e.description).toBe(event.description);
  expect(e.startDate.toString()).toBe("2026-10-20T12:00:00Z");
  expect(e.endDate.toString()).toBe("2026-10-20T12:25:00Z");
  for (const line of text.split("\r\n"))
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  expect(text).toBe(
    serializeCalendar([event], Date.parse("2026-10-13T12:00:00Z")),
  );
});
it("emits valid empty feeds and omits unknown duration", () => {
  expect(
    new ICAL.Component(
      ICAL.parse(serializeCalendar([], 0)),
    ).getAllSubcomponents("vevent"),
  ).toEqual([]);
  expect(serializeCalendar([{ ...event, end: undefined }], 0)).not.toContain(
    "DTEND",
  );
});
it("date-only entries use exclusive next-day DTEND", () => {
  const events = selectEvents(
    [
      {
        category: "movies",
        id: 1,
        title: "Movie",
        url: "https://simkl.com/movies/1/",
        date: "2026-12-31",
      },
    ],
    [{ category: "movies", id: 1, status: "plantowatch", title: "Movie" }],
    { categories: ["movies"], statuses: ["plantowatch"] },
    "all",
  );
  const text = serializeCalendar(events, 0);
  expect(text).toContain("DTSTART;VALUE=DATE:20261231");
  expect(text).toContain("DTEND;VALUE=DATE:20270101");
});
it("serializes nonzero milliseconds as whole-second UTC modification times", () => {
  const text = serializeCalendar(
    [event],
    Date.parse("2026-10-13T12:00:00.123Z"),
  );
  expect(text).toContain("DTSTAMP:20261013T120000Z\r\n");
  expect(text).toContain("LAST-MODIFIED:20261013T120000Z\r\n");
  const component = new ICAL.Component(ICAL.parse(text)).getFirstSubcomponent(
    "vevent",
  )!;
  for (const name of ["dtstamp", "last-modified"]) {
    const time = component.getFirstPropertyValue(name) as ICAL.Time;
    expect(time.zone).toBe(ICAL.Timezone.utcTimezone);
    expect(time.toString()).toBe("2026-10-13T12:00:00Z");
  }
});
