export const CATEGORIES = ["tv", "anime", "movies"] as const;
export const STATUSES = [
  "watching",
  "plantowatch",
  "hold",
  "completed",
  "dropped",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type FeedCategory = Category | "all";
export type Status = (typeof STATUSES)[number];
export interface Preferences {
  categories: Category[];
  statuses: Status[];
}
export const DEFAULT_PREFERENCES: Preferences = {
  categories: [...CATEGORIES],
  statuses: ["watching", "plantowatch"],
};
export interface WatchItem {
  category: Category;
  id: number;
  status: Status;
  title: string;
}
export interface ScheduleRow {
  category: Category;
  id: number;
  date: string;
  title: string;
  url: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  runtimeMinutes?: number;
  finale?: 1 | 2 | 3;
  animeMovie?: boolean;
}
export interface CalendarEvent {
  uid: string;
  start: string;
  end?: string;
  allDay: boolean;
  summary: string;
  description: string;
  url: string;
}
export interface Dataset {
  rows: ScheduleRow[];
  validatedAt: number;
  modifiedAt: number;
}
export interface Activities {
  all: string | null;
  tv_shows: Record<string, string | null>;
  anime: Record<string, string | null>;
  movies: Record<string, string | null>;
}
export interface WatchSnapshot {
  items: WatchItem[];
  activities: Activities;
  validatedAt: number;
}
export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}
export interface OAuthTransaction {
  verifier: string;
  bindingHash: string;
  expiresAt: number;
  redirectUri: string;
}
export interface DispatchRequest {
  path: string;
  method: "GET" | "POST";
  token?: string;
  query?: Record<string, string>;
  form?: Record<string, string>;
}
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface DispatchResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function positiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
export interface AccountView {
  preferences: Preferences;
  csrf: string;
  secret: string | null;
  validatedAt: number | null;
  connected: boolean;
  degraded: boolean;
}
export type AccountAction =
  | { type: "preferences"; preferences: Preferences }
  | { type: "refresh" | "rotate" | "revoke" | "disconnect" | "logout" };
