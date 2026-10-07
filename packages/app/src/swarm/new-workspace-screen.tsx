import { SwarmCreationError } from "./parent-selection";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  NewWorkspaceScreen,
  type SwarmRoleChoice,
  type SwarmWorkspaceOptions,
} from "@/screens/new-workspace-screen";
import { usePluginInstallations } from "@/plugins/registry";
import { swarmTaskBoardSchema } from "./task-model";
import { type SwarmRoleClass } from "./rpc";
import { z } from "zod";

const rolesSchema = z.array(
  z.object({
    role: z.string(),
    roleClass: z.enum(["planner", "supervisor", "worker"]),
    title: z.string(),
    description: z.string(),
  }),
);
const preparedAgentSchema = z.object({ agentId: z.string(), systemPrompt: z.string() });

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
  const installations = usePluginInstallations("paseo-swarm");
  const options = useMemo<SwarmWorkspaceOptions>(() => {
    function installationFor(targetServerId: string) {
      const installation = installations.find((plugin) => plugin.serverId === targetServerId);
      if (!installation) throw new SwarmCreationError("swarm.creation.notInstalled");
      return installation;
    }
    return {
      roleClass,
      initialParent: parentName,
      initialName: roleClass,
      async loadTarget(target) {
        const installation = installationFor(target.serverId);
        const [roleResponse, boardResponse] = await Promise.all([
          installation.invoke("swarm.pwa_roles.read", { roleClass, projectId: target.projectId }),
          installation.invoke("swarm.board.read", {}),
        ]);
        const roles: SwarmRoleChoice[] = rolesSchema.parse(roleResponse);
        const board = swarmTaskBoardSchema.parse(boardResponse);
        let parentRoleClass: "planner" | "supervisor" | null = null;
        if (roleClass === "supervisor") parentRoleClass = "planner";
        if (roleClass === "worker") parentRoleClass = "supervisor";
        const parents = board.agents
          .filter((agent) => agent.roleClass === parentRoleClass && !agent.retired)
          .map((agent) => ({
            name: agent.qualifiedName ?? agent.name,
            title: agent.qualifiedName ?? agent.name,
            displayName: agent.name,
            paseoAgentId: agent.paseoAgentId,
            serverId: target.serverId,
            workspaceId: agent.workspaceId,
          }));
        return { roles, parents };
      },
      async prepareAgent({ target, ...input }) {
        const installation = installationFor(target.serverId);
        return preparedAgentSchema.parse(
          await installation.invoke("swarm.agent.prepare", {
            ...input,
            projectId: target.projectId,
            roleClass,
            actorPaseoAgentId: null,
          }),
        );
      },
      async bindAgent({ serverId: targetServerId, agentId, workspaceId }) {
        await installationFor(targetServerId).invoke("swarm.agent.bind_workspace", {
          agentId,
          workspaceId,
        });
      },
    };
  }, [installations, parentName, roleClass]);
  return (
    <NewWorkspaceScreen
      serverId={serverId}
      sourceDirectory={sourceDirectory}
      projectId={projectId}
      displayName={displayName}
      draftId={draftId}
      title={t("newWorkspace.roleTitle", { role: t(`swarm.roles.${roleClass}`) })}
      swarm={options}
    />
  );
}
