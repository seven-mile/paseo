import { useEffect, useId, useLayoutEffect } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

// The workspace demands timelines only for the agent tabs it shows (`visible-agent-ids.ts`), and a
// seat's agent comes from the roster, not the tab target. So a seat tab demands the agent it
// shows itself while it is on screen; otherwise that conversation never leaves its loading state.
export function useSeatAgentTimeline(serverId: string, agentId: string | null, active: boolean) {
  const sourceId = `swarm-seat:${useId()}`;
  const sync = useSessionStore((state) => state.sessions[serverId]?.viewedTimelineSync ?? null);
  const demanded = active ? agentId : null;
  useEffect(() => {
    if (!demanded) return;
    void getHostRuntimeStore()
      .prepareAgentTimeline(serverId, demanded)
      .catch(() => undefined);
  }, [demanded, serverId]);
  useLayoutEffect(() => {
    if (!sync || !demanded) return;
    sync.replaceVisibleAgentIds(sourceId, [demanded]);
    return () => sync.replaceVisibleAgentIds(sourceId, []);
  }, [demanded, sourceId, sync]);
}
