import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];

// Shims and timers act between hooks, so they use the plugin's long-lived Paseo client from
// whichever hook or handler ran last.
let current: PaseoApi | null = null;

export function attachPaseo(paseo: PaseoApi): void {
  current = paseo;
}

export function currentPaseo(): PaseoApi | null {
  return current;
}
