import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
export class Coordinator extends DurableObject<Env> {}
