import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  NewWorkspaceScreen,
  type SwarmRoleChoice,
  type SwarmWorkspaceOptions,
} from "@/screens/new-workspace-screen";
import { useSwarmRpc, type SwarmAgentSummary, type SwarmRoleClass } from "./rpc";

interface SwarmBoardResponse {
  agents: SwarmAgentSummary[];
}

export interface SwarmNewWorkspaceScreenProps {
  serverId: string;
  sourceDirectory?: string;
  projectId?: string;
  displayName?: string;
  draftId?: string;
  roleClass: SwarmRoleClass;
  parentName?: string;
}

export function SwarmNewWorkspaceScreen({
  serverId,
  sourceDirectory,
  projectId,
  displayName,
  draftId,
  roleClass,
  parentName,
}: SwarmNewWorkspaceScreenProps) {
  const { t } = useTranslation();
  const { plugin, invoke } = useSwarmRpc(serverId);
  const [roles, setRoles] = useState<SwarmRoleChoice[]>([]);
  const [agents, setAgents] = useState<SwarmAgentSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([
      invoke<SwarmRoleChoice[]>("swarm.pwa_roles.read", { roleClass }),
      invoke<SwarmBoardResponse>("swarm.board.read", {}),
    ])
      .then(([roleChoices, board]) => {
        if (!active) return null;
        setRoles(roleChoices);
        setAgents(board.agents);
        setLoaded(true);
        return null;
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [invoke, roleClass]);

  const options = useMemo<SwarmWorkspaceOptions | null>(() => {
    if (!plugin || roles.length === 0) return null;
    let parentRoleClass: "planner" | "supervisor" | null = null;
    if (roleClass === "supervisor") parentRoleClass = "planner";
    if (roleClass === "worker") parentRoleClass = "supervisor";
    const parents = agents
      .filter(
        (agent) =>
          parentRoleClass !== null && agent.roleClass === parentRoleClass && !agent.retired,
      )
      .map((agent) => ({
        name: agent.qualifiedName ?? agent.name,
        title: agent.qualifiedName ?? agent.name,
        displayName: agent.name,
        paseoAgentId: agent.paseoAgentId,
        serverId,
        workspaceId: agent.workspaceId,
      }));
    return {
      roleClass,
      roles,
      parents,
      initialRole: roles[0]?.role,
      initialParent: parents.some((parent) => parent.name === parentName)
        ? parentName
        : parents[0]?.name,
      initialName: roleClass,
      prepareAgent: async ({ name, role, reportsTo, brief }) => {
        const prepared = await invoke<{
          agentId: string;
          systemPrompt: string;
        }>("swarm.agent.prepare", {
          name,
          role,
          roleClass,
          reportsTo,
          actorPaseoAgentId: null,
          brief,
        });
        return prepared;
      },
      bindAgent: async ({ agentId, workspaceId }) => {
        await invoke("swarm.agent.bind_workspace", { agentId, workspaceId });
      },
    };
  }, [agents, invoke, parentName, plugin, roleClass, roles, serverId]);

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }
  if (!loaded) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!options) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>No {roleClass} roles are configured in the active PWA.</Text>
      </View>
    );
  }
  return (
    <NewWorkspaceScreen
      serverId={serverId}
      sourceDirectory={sourceDirectory}
      projectId={projectId}
      displayName={displayName}
      draftId={draftId}
      title={t("newWorkspace.roleTitle", { role: roleClass })}
      swarm={options}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[6],
  },
  errorText: {
    color: theme.colors.destructive,
    textAlign: "center",
  },
}));
