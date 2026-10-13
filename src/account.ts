import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
export class Account extends DurableObject<Env> {}
