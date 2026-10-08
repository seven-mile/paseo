import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ChevronDown, ChevronRight, ListTodo, Plus, Users } from "lucide-react-native";
import { router } from "expo-router";
import {
  useCallback,
  useMemo,
  useState,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { GestureType } from "react-native-gesture-handler";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { z } from "zod";
import { AGENT_LIFECYCLE_STATUSES } from "@getpaseo/protocol/agent-lifecycle";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { usePluginInstallations } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useFetchQuery } from "@/data/query";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openSwarmTasks } from "./navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { getSidebarRowBackdrop } from "@/components/sidebar/sidebar-row-backdrop";
import { ProjectLeadingVisual } from "@/components/sidebar/project-leading-visual";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { builtinSidebarNavShortcutAction } from "@/sidebar-nav/model";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore, type Agent as SessionAgent } from "@/stores/session-store";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import {
  applyStoredOrdering,
  areSidebarWorkspaceSessionsEqual,
  deriveEffectiveWorkspaceStatus,
  selectSidebarWorkspaceSessions,
  type SidebarWorkspaceEntry,
} from "@/hooks/sidebar-workspaces-view-model";
import { WorkspaceStatusIndicator } from "@/components/sidebar/sidebar-workspace-row-content";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";

// Follows the Classical sidebar's project/workspace rows; Swarm changes only the semantic slots.

const preferenceSchema = z.object({ mode: z.enum(["classical", "swarm"]) });
type Mode = z.infer<typeof preferenceSchema>["mode"];
export const useSwarmSidebar = create<{ mode: Mode; setMode: (mode: Mode) => void }>()(
  persist((set) => ({ mode: "classical", setMode: (mode) => set({ mode }) }), {
    name: "swarm-sidebar",
    storage: createValidatedPersistStorage(AsyncStorage, preferenceSchema),
    partialize: ({ mode }) => ({ mode }),
  }),
);

const rosterSchema = z.object({
  agents: z.array(
    z.object({
      paseoAgentId: z.string(),
      name: z.string(),
      qualifiedName: z.string().optional(),
      roleClass: z.enum(["planner", "supervisor", "worker"]),
      reportsTo: z.string().nullable(),
      workspaceId: z.string().nullable(),
      retired: z.boolean(),
    }),
  ),
});
type Agent = z.infer<typeof rosterSchema>["agents"][number];
type WorkspaceState = Pick<SidebarWorkspaceEntry, "statusBucket" | "workspaceKind">;
interface SwarmSidebarGestureProps {
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostActive?: boolean;
}
interface SwarmRowDragProps {
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}
const EMPTY_ORDER: string[] = [];
const EMPTY_AGENTS: Agent[] = [];
const agentKeyExtractor = (agent: Agent) => agent.paseoAgentId;
const modes: Array<{ value: Mode; label: string; testID: string }> = [
  { value: "classical", label: "swarm.sidebar.classical", testID: "swarm-sidebar-classical" },
  { value: "swarm", label: "swarm.sidebar.swarm", testID: "swarm-sidebar-swarm" },
];
const ThemedUsers = withUnistyles(Users);
const ThemedListTodo = withUnistyles(ListTodo);
const ThemedPlus = withUnistyles(Plus);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function useOrderedSwarmAgents(agents: Agent[], scope: string) {
  const order = useSidebarOrderStore(
    (state) => state.workspaceOrderByProject[scope] ?? EMPTY_ORDER,
  );
  const getOrder = useSidebarOrderStore((state) => state.getWorkspaceOrder);
  const setOrder = useSidebarOrderStore((state) => state.setWorkspaceOrder);
  const orderedAgents = useMemo(
    () => applyStoredOrdering({ items: agents, storedOrder: order, getKey: agentKeyExtractor }),
    [agents, order],
  );
  const onDragEnd = useCallback(
    (reordered: Agent[]) => {
      const currentOrder = getOrder(scope);
      const reorderedVisibleKeys = reordered.map(agentKeyExtractor);
      if (!hasVisibleOrderChanged({ currentOrder, reorderedVisibleKeys })) return;
      setOrder(scope, mergeWithRemainder({ currentOrder, reorderedVisibleKeys }));
    },
    [getOrder, scope, setOrder],
  );
  return { orderedAgents, onDragEnd };
}

export function SwarmCreatePlannerNavRow({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { t } = useTranslation();
  const installation = usePluginInstallations("paseo-swarm")[0];
  const selection = useActiveWorkspaceSelection();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const open = useCallback(() => {
    const serverId = selection?.serverId ?? installation?.serverId;
    if (!serverId) return;
    onBeforeNavigate?.();
    router.push({ pathname: "/new", params: { serverId, swarmRoleClass: "supervisor" } });
  }, [installation?.serverId, onBeforeNavigate, selection?.serverId]);
  return (
    <SidebarHeaderRow
      icon={Plus}
      label={t("swarm.sidebar.addSupervisor")}
      variant="compact"
      shortcutKeys={shortcutKeys}
      onPress={open}
    />
  );
}

export function useOpenSwarmPlanner() {
  const selection = useActiveWorkspaceSelection();
  const installations = usePluginInstallations("paseo-swarm");
  const installation =
    installations.find((candidate) => candidate.serverId === selection?.serverId) ??
    installations[0];
  return useCallback(() => {
    const serverId = selection?.serverId ?? installation?.serverId;
    if (!serverId) return;
    router.push({
      pathname: "/new",
      params: { serverId, swarmRoleClass: "planner" },
    });
  }, [installation?.serverId, selection?.serverId]);
}

function PlannerGroup({
  planner,
  agents,
  serverId,
  selectedAgent,
  workspaceStates,
  drag,
  isDragging,
  dragHandleProps,
  parentGestureRef,
  dragGestureHostActive,
  onOpenTasks,
  onOpenSurface,
}: SwarmSidebarGestureProps &
  SwarmRowDragProps & {
    planner: Agent;
    agents: Agent[];
    serverId: string;
    selectedAgent?: Agent;
    workspaceStates: ReadonlyMap<string, WorkspaceState>;
    onOpenTasks: (agent: Agent, planner: Agent) => void;
    onOpenSurface: (surfaceId: string, params?: Record<string, string>) => void;
  }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const openAgent = useCallback(
    (agent: Agent) =>
      navigateToAgent({
        serverId,
        agentId: agent.paseoAgentId,
        workspaceId: agent.workspaceId,
      }),
    [serverId],
  );
  const supervisors = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.roleClass === "supervisor" &&
          agent.reportsTo === (planner.qualifiedName ?? planner.name),
      ),
    [agents, planner.qualifiedName, planner.name],
  );
  const { orderedAgents: orderedSupervisors, onDragEnd } = useOrderedSwarmAgents(
    supervisors,
    `swarm:supervisors:${serverId}:${planner.paseoAgentId}`,
  );
  const isSelected = useCallback(
    (agent: Agent) => selectedAgent?.paseoAgentId === agent.paseoAgentId,
    [selectedAgent],
  );
  const openPlanner = useCallback(() => openAgent(planner), [openAgent, planner]);
  const openPlannerTasks = useCallback(() => onOpenTasks(planner, planner), [onOpenTasks, planner]);
  const openAgentTasks = useCallback(
    (agent: Agent) => onOpenTasks(agent, planner),
    [onOpenTasks, planner],
  );
  const openCreateSupervisor = useCallback(
    () =>
      onOpenSurface("native-create-supervisor", { parent: planner.qualifiedName ?? planner.name }),
    [onOpenSurface, planner],
  );
  const openCreateWorker = useCallback(
    (agent: Agent) =>
      onOpenSurface("native-create-worker", { parent: agent.qualifiedName ?? agent.name }),
    [onOpenSurface],
  );
  const renderSupervisor = useCallback(
    ({
      item: agent,
      drag: supervisorDrag,
      isActive,
      dragHandleProps: supervisorDragHandleProps,
    }: DraggableRenderItemInfo<Agent>) => (
      <AgentRow
        serverId={serverId}
        agent={agent}
        selected={isSelected(agent)}
        workspaceState={workspaceStates.get(agent.paseoAgentId)}
        members={agents.filter(
          (member) => member.reportsTo === (agent.qualifiedName ?? agent.name),
        )}
        onOpen={openAgent}
        onOpenTasks={openAgentTasks}
        onAddWorker={openCreateWorker}
        drag={supervisorDrag}
        isDragging={isActive}
        dragHandleProps={supervisorDragHandleProps}
      />
    ),
    [serverId, agents, isSelected, openAgent, openAgentTasks, openCreateWorker, workspaceStates],
  );
  const supervisorExtraData = useMemo(
    () => ({ selectedAgent, workspaceStates, agents, openAgent, openAgentTasks, openCreateWorker }),
    [selectedAgent, workspaceStates, agents, openAgent, openAgentTasks, openCreateWorker],
  );
  return (
    <View>
      <PlannerRow
        planner={planner}
        selected={isSelected(planner)}
        expanded={expanded}
        onToggle={toggleExpanded}
        onOpen={openPlanner}
        onOpenTasks={openPlannerTasks}
        onAddSupervisor={openCreateSupervisor}
        drag={drag}
        isDragging={isDragging}
        dragHandleProps={dragHandleProps}
      />
      {expanded ? (
        <View style={styles.members}>
          <DraggableList
            testID={`swarm-supervisor-list-${serverId}-${planner.paseoAgentId}`}
            data={orderedSupervisors}
            keyExtractor={agentKeyExtractor}
            renderItem={renderSupervisor}
            onDragEnd={onDragEnd}
            extraData={supervisorExtraData}
            scrollEnabled={false}
            useDragHandle
            nestable={isNative}
            simultaneousGestureRef={parentGestureRef}
            gestureHostPresented={dragGestureHostActive}
            containerStyle={styles.members}
          />
          {supervisors.length === 0 ? (
            <View style={styles.workspaceRow}>
              <View style={styles.workspaceRowMain}>
                <View style={styles.supervisorStatusSlot} />
                <Text style={styles.workspaceTitle}>{t("swarm.sidebar.noSupervisors")}</Text>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function PlannerRow({
  planner,
  selected,
  expanded,
  onToggle,
  onOpen,
  onOpenTasks,
  onAddSupervisor,
  drag,
  isDragging,
  dragHandleProps,
}: SwarmRowDragProps & {
  planner: Agent;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenTasks: () => void;
  onAddSupervisor: () => void;
}) {
  const { t } = useTranslation();
  const selectionAccessibilityState = useMemo(() => ({ selected }), [selected]);
  const expansionAccessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  const interaction = useLongPressDragInteraction({ drag, menuController: null });
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);
  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      setPressed(true);
      interaction.handlePressIn(event);
    },
    [interaction],
  );
  const handlePressOut = useCallback(() => {
    setPressed(false);
    interaction.handlePressOut();
  }, [interaction]);
  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onOpen();
  }, [interaction.didLongPressRef, onOpen]);
  const handleTogglePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onToggle();
    },
    [onToggle],
  );
  const handleControlPressStart = useCallback((event: { stopPropagation(): void }) => {
    event.stopPropagation();
  }, []);
  const handleAddSupervisor = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onAddSupervisor();
    },
    [onAddSupervisor],
  );
  const handleOpenTasks = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onOpenTasks();
    },
    [onOpenTasks],
  );
  const selectionStyle = useCallback(
    ({ pressed: rowPressed }: PressableStateCallbackType) => [
      styles.rowSelectionTarget,
      rowPressed && styles.projectRowPressed,
    ],
    [],
  );
  return (
    <View
      {...(isWeb ? { onMouseEnter: handleMouseEnter, onMouseLeave: handleMouseLeave } : {})}
      style={[
        styles.projectRow,
        (hovered || focused) && styles.projectRowHovered,
        selected && styles.projectRowSelected,
        (pressed || isDragging) && styles.projectRowPressed,
      ]}
    >
      <View
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
        style={styles.rowSelectionTarget}
      >
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={planner.name}
          accessibilityState={selectionAccessibilityState}
          aria-selected={selected}
          testID={`swarm-planner-row-${planner.paseoAgentId}`}
          style={selectionStyle}
          highlightStyle={styles.projectRowPressed}
          onPressIn={handlePressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={handlePressOut}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPress={handlePress}
        />
      </View>
      <View style={styles.projectRowLeft} pointerEvents="none">
        <ProjectLeadingVisual
          displayName={planner.name}
          iconDataUri={null}
          statusBucket={null}
          projectViewKey={`swarm:${planner.paseoAgentId}`}
          backdrop={getSidebarRowBackdrop({
            isHovered: hovered || focused,
            isPressed: pressed,
            isDragging,
            selected,
          })}
        />
        <Text style={styles.projectTitle} numberOfLines={1}>
          {planner.name}
        </Text>
      </View>
      <View style={styles.projectTrailingActions} pointerEvents="box-none">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(expanded ? "swarm.sidebar.collapse" : "swarm.sidebar.expand", {
            name: planner.name,
          })}
          accessibilityState={expansionAccessibilityState}
          aria-expanded={expanded}
          testID={`swarm-planner-toggle-${planner.paseoAgentId}`}
          onTouchStart={handleControlPressStart}
          onPointerDown={handleControlPressStart}
          onPress={handleTogglePress}
          style={styles.projectIconActionButton}
        >
          {expanded ? (
            <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
          ) : (
            <ThemedChevronRight size={14} uniProps={mutedColorMapping} />
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("swarm.sidebar.addSupervisorUnder", { name: planner.name })}
          onTouchStart={handleControlPressStart}
          onPointerDown={handleControlPressStart}
          onPress={handleAddSupervisor}
          style={styles.projectIconActionButton}
        >
          <ThemedPlus size={14} uniProps={mutedColorMapping} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("swarm.sidebar.openTasks", { name: planner.name })}
          testID={`swarm-planner-tasks-${planner.paseoAgentId}`}
          onTouchStart={handleControlPressStart}
          onPointerDown={handleControlPressStart}
          onPress={handleOpenTasks}
          style={styles.projectIconActionButton}
        >
          <ThemedListTodo size={14} uniProps={mutedColorMapping} />
        </Pressable>
      </View>
    </View>
  );
}

function AgentRow({
  serverId,
  agent,
  members,
  selected,
  workspaceState,
  onOpen,
  onOpenTasks,
  onAddWorker,
  drag,
  isDragging,
  dragHandleProps,
}: SwarmRowDragProps & {
  serverId: string;
  agent: Agent;
  members: Agent[];
  selected: boolean;
  workspaceState?: WorkspaceState;
  onOpen: (agent: Agent) => void;
  onOpenTasks: (agent: Agent) => void;
  onAddWorker: (agent: Agent) => void;
}) {
  const { t } = useTranslation();
  const selectionAccessibilityState = useMemo(() => ({ selected }), [selected]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const interaction = useLongPressDragInteraction({ drag, menuController: null });
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);
  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onOpen(agent);
  }, [agent, interaction.didLongPressRef, onOpen]);
  const handleTasks = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onOpenTasks(agent);
    },
    [agent, onOpenTasks],
  );
  const handleAddWorker = useCallback(() => onAddWorker(agent), [agent, onAddWorker]);
  const selectionStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.rowSelectionTarget,
      pressed && styles.workspaceRowPressed,
    ],
    [],
  );
  return (
    <View
      {...(isWeb ? { onMouseEnter: handleMouseEnter, onMouseLeave: handleMouseLeave } : {})}
      style={[
        styles.workspaceRow,
        (hovered || focused) && styles.workspaceRowHovered,
        selected && styles.workspaceRowSelected,
        isDragging && styles.workspaceRowPressed,
      ]}
    >
      <View
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
        style={styles.rowSelectionTarget}
      >
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={agent.name}
          accessibilityState={selectionAccessibilityState}
          aria-selected={selected}
          testID={`swarm-agent-row-${agent.paseoAgentId}`}
          style={selectionStyle}
          highlightStyle={styles.workspaceRowPressed}
          onPressIn={interaction.handlePressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={interaction.handlePressOut}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPress={handlePress}
        />
      </View>
      <View style={styles.workspaceRowMain} pointerEvents="none">
        <WorkspaceStatusIndicator
          bucket={workspaceState?.statusBucket ?? "done"}
          workspaceKind={workspaceState?.workspaceKind ?? "checkout"}
          loading={Boolean(agent.workspaceId && !workspaceState)}
        />
        <Text style={styles.workspaceTitle} numberOfLines={1}>
          {agent.name}
        </Text>
      </View>
      <View style={styles.projectTrailingActions} pointerEvents="box-none">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("swarm.sidebar.openTasks", { name: agent.name })}
          testID={`swarm-agent-tasks-${agent.paseoAgentId}`}
          onPress={handleTasks}
          style={styles.projectIconActionButton}
        >
          <ThemedListTodo size={14} uniProps={mutedColorMapping} />
        </Pressable>
        <RosterHoverCard
          serverId={serverId}
          agent={agent}
          members={members}
          onOpen={onOpen}
          onOpenTasks={onOpenTasks}
          onAddWorker={handleAddWorker}
        />
      </View>
    </View>
  );
}

function RosterHoverCard({
  serverId,
  agent,
  members,
  onOpen,
  onOpenTasks,
  onAddWorker,
}: {
  serverId: string;
  agent: Agent;
  members: Agent[];
  onOpen: (agent: Agent) => void;
  onOpenTasks: (agent: Agent) => void;
  onAddWorker: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  if (isCompact || !isWeb)
    return (
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          accessibilityLabel={t("swarm.sidebar.openTeam", { name: agent.name })}
          style={styles.teamTrigger}
        >
          <ThemedUsers size={14} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent sheetTitle={t("swarm.sidebar.agentTeam")}>
          {[agent, ...members].map((member) => (
            <RosterMenuEntry
              key={member.paseoAgentId}
              serverId={serverId}
              agent={member}
              onOpen={onOpen}
              onOpenTasks={onOpenTasks}
            />
          ))}
          <DropdownMenuItem onSelect={onAddWorker}>{t("swarm.sidebar.addWorker")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  return (
    <HoverCard>
      <HoverCardTrigger
        focusable
        accessibilityLabel={t("swarm.sidebar.openTeam", { name: agent.name })}
      >
        <View style={styles.teamTrigger}>
          <ThemedUsers size={14} uniProps={mutedColorMapping} />
        </View>
      </HoverCardTrigger>
      <HoverCardContent placement="right" role="menu" style={styles.rosterCard}>
        <Text style={styles.rosterTitle}>{t("swarm.sidebar.agentTeam")}</Text>
        <RosterEntry
          serverId={serverId}
          agent={agent}
          current
          onOpen={onOpen}
          onOpenTasks={onOpenTasks}
        />
        {members.map((member) => (
          <RosterEntry
            key={member.paseoAgentId}
            serverId={serverId}
            agent={member}
            onOpen={onOpen}
            onOpenTasks={onOpenTasks}
          />
        ))}
        {members.length === 0 ? (
          <Text style={styles.hint}>{t("swarm.sidebar.noWorkers")}</Text>
        ) : null}
        <Pressable
          accessibilityRole="menuitem"
          accessibilityLabel={t("swarm.sidebar.addWorkerUnder", { name: agent.name })}
          onPress={onAddWorker}
          style={styles.rosterAction}
        >
          <ThemedPlus size={14} uniProps={mutedColorMapping} />
          <Text style={styles.rosterActionText}>{t("swarm.sidebar.addWorker")}</Text>
        </Pressable>
      </HoverCardContent>
    </HoverCard>
  );
}

function useRosterStatus(serverId: string, agentId: string) {
  const { t } = useTranslation();
  const runtimeAgent = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
  });
  if (!runtimeAgent || !AGENT_LIFECYCLE_STATUSES.some((status) => status === runtimeAgent.status)) {
    return { runtimeAgent: null, statusLabel: null };
  }
  const pendingPermissionCount = runtimeAgent.pendingPermissions.length;
  const bucket = deriveSidebarStateBucket({
    status: runtimeAgent.status,
    requiresAttention: runtimeAgent.requiresAttention,
    attentionReason: runtimeAgent.attentionReason,
    pendingPermissionCount,
  });
  let statusLabel: string;
  if (bucket === "needs_input") {
    statusLabel =
      pendingPermissionCount > 0
        ? t("agentList.badges.pending", { count: pendingPermissionCount })
        : t("subagents.pillLabelNeedsInputOne");
  } else if (bucket === "failed") {
    statusLabel = t("agentList.status.error");
  } else if (bucket === "attention") {
    statusLabel = t("agentList.badges.attention");
  } else {
    statusLabel = t(`agentList.status.${runtimeAgent.status}`);
  }
  return { runtimeAgent, statusLabel };
}

function RosterStatusMarker({ agent }: { agent: SessionAgent | null }) {
  return (
    <View
      style={styles.rosterStatusSlot}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
    >
      {agent ? (
        <AgentStatusDot
          status={agent.status}
          requiresAttention={agent.requiresAttention}
          attentionReason={agent.attentionReason}
          pendingPermissionCount={agent.pendingPermissions.length}
          showInactive
        />
      ) : (
        <ThemedUsers size={14} uniProps={mutedColorMapping} />
      )}
    </View>
  );
}

function RosterEntry({
  serverId,
  agent,
  current = false,
  onOpen,
  onOpenTasks,
}: {
  serverId: string;
  agent: Agent;
  current?: boolean;
  onOpen: (agent: Agent) => void;
  onOpenTasks: (agent: Agent) => void;
}) {
  const { t } = useTranslation();
  const { runtimeAgent, statusLabel } = useRosterStatus(serverId, agent.paseoAgentId);
  const metadata = [t(`swarm.roles.${current ? "supervisor" : agent.roleClass}`), statusLabel]
    .filter(Boolean)
    .join(", ");
  const handlePress = useCallback(() => onOpen(agent), [agent, onOpen]);
  const handleTasks = useCallback(() => onOpenTasks(agent), [agent, onOpenTasks]);
  return (
    <View style={styles.rosterEntry}>
      <Pressable
        style={styles.rosterEntryMain}
        onPress={handlePress}
        accessibilityRole="menuitem"
        accessibilityLabel={`${agent.name}, ${metadata}`}
      >
        <RosterStatusMarker agent={runtimeAgent} />
        <View style={styles.rosterEntryText}>
          <Text style={styles.rosterName}>{agent.name}</Text>
          <Text style={styles.rosterMeta}>{metadata}</Text>
        </View>
      </Pressable>
      <Button
        variant="ghost"
        size="xs"
        onPress={handleTasks}
        accessibilityLabel={t("swarm.sidebar.openTasks", { name: agent.name })}
        testID={`swarm-roster-tasks-${agent.paseoAgentId}`}
      >
        {t("swarm.tasks.title")}
      </Button>
    </View>
  );
}

function RosterMenuEntry({
  serverId,
  agent,
  onOpen,
  onOpenTasks,
}: {
  serverId: string;
  agent: Agent;
  onOpen: (agent: Agent) => void;
  onOpenTasks: (agent: Agent) => void;
}) {
  const { t } = useTranslation();
  const { runtimeAgent, statusLabel } = useRosterStatus(serverId, agent.paseoAgentId);
  const leading = useMemo(() => <RosterStatusMarker agent={runtimeAgent} />, [runtimeAgent]);
  const description = [t(`swarm.roles.${agent.roleClass}`), statusLabel].filter(Boolean).join(", ");
  const open = useCallback(() => onOpen(agent), [agent, onOpen]);
  const tasks = useCallback(() => onOpenTasks(agent), [agent, onOpenTasks]);
  return (
    <>
      <DropdownMenuItem onSelect={open} leading={leading} description={description}>
        {agent.name}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={tasks}>
        {t("swarm.sidebar.tasksFor", { name: agent.name })}
      </DropdownMenuItem>
    </>
  );
}

function HostRoster({
  plugin,
  parentGestureRef,
  dragGestureHostActive,
}: SwarmSidebarGestureProps & { plugin: InstalledPlugin }) {
  const { t } = useTranslation();
  const selection = useActiveWorkspaceSelection();
  const isCompact = useIsCompactFormFactor();
  // Subscribe once per host to the same workspace/activity indexes used by Classical.
  // The roster identifies the workspace; it is not the source of its runtime status.
  const sessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSidebarWorkspaceSessions(state.sessions, [plugin.serverId]),
    areSidebarWorkspaceSessionsEqual,
  );
  const pendingCreateAttempts = useCreateFlowStore((state) => state.pendingByDraftId);
  const query = useFetchQuery(
    {
      queryKey: ["swarm", "roster", plugin.serverId],
      queryFn: async () => rosterSchema.parse(await plugin.invoke("swarm.board.read", {})),
      refetchInterval: 3000,
      dataShape: "value",
      staleTimeMs: 2500,
    },
    plugin.queryClient,
  );
  const workspaceStates = useMemo(() => {
    const states = new Map<string, WorkspaceState>();
    const session = sessions[0];
    if (!session) return states;
    for (const agent of query.data?.agents ?? []) {
      if (agent.roleClass !== "supervisor" || agent.retired) continue;
      const key = resolveWorkspaceMapKeyByIdentity({
        workspaces: session.workspaces,
        workspaceId: agent.workspaceId,
      });
      const workspace = key ? session.workspaces.get(key) : undefined;
      if (!workspace) continue;
      states.set(agent.paseoAgentId, {
        statusBucket: deriveEffectiveWorkspaceStatus({
          serverId: plugin.serverId,
          workspace,
          workspaceAgentActivity: session.workspaceAgentActivity,
          pendingCreateAttempts,
        }).status,
        workspaceKind: workspace.workspaceKind,
      });
    }
    return states;
  }, [pendingCreateAttempts, plugin.serverId, query.data, sessions]);
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const openSurface = useCallback(
    (surfaceId: string, params: Record<string, string> = {}) => {
      if (surfaceId === "native-create-supervisor" || surfaceId === "native-create-worker") {
        router.push({
          pathname: "/new",
          params: {
            serverId: plugin.serverId,
            swarmRoleClass: surfaceId === "native-create-supervisor" ? "supervisor" : "worker",
            ...(params.parent ? { swarmParent: params.parent } : {}),
          },
        });
        return;
      }
    },
    [plugin.serverId],
  );
  const openTasks = useCallback(
    (agent: Agent, planner: Agent) => {
      const workspaceId = agent.workspaceId ?? planner.workspaceId;
      if (!workspaceId) return;
      openSwarmTasks({
        serverId: plugin.serverId,
        workspaceId,
        plannerName: planner.qualifiedName ?? planner.name,
        agentName: agent.roleClass === "planner" ? undefined : (agent.qualifiedName ?? agent.name),
        host: agent.roleClass === "planner" ? "main" : "explorer",
        isCompact,
      });
    },
    [isCompact, plugin.serverId],
  );
  const agents = useMemo(
    () => query.data?.agents.filter((agent) => !agent.retired) ?? EMPTY_AGENTS,
    [query.data],
  );
  const selectedAgent =
    selection?.serverId === plugin.serverId
      ? agents.find((agent) => agent.workspaceId === selection.workspaceId)
      : undefined;
  const planners = useMemo(() => agents.filter((agent) => agent.roleClass === "planner"), [agents]);
  const { orderedAgents: orderedPlanners, onDragEnd } = useOrderedSwarmAgents(
    planners,
    `swarm:planners:${plugin.serverId}`,
  );
  const renderPlanner = useCallback(
    ({ item: planner, drag, isActive, dragHandleProps }: DraggableRenderItemInfo<Agent>) => (
      <PlannerGroup
        planner={planner}
        agents={agents}
        serverId={plugin.serverId}
        selectedAgent={selectedAgent}
        workspaceStates={workspaceStates}
        onOpenTasks={openTasks}
        onOpenSurface={openSurface}
        drag={drag}
        isDragging={isActive}
        dragHandleProps={dragHandleProps}
        parentGestureRef={parentGestureRef}
        dragGestureHostActive={dragGestureHostActive}
      />
    ),
    [
      agents,
      plugin.serverId,
      selectedAgent,
      workspaceStates,
      openTasks,
      openSurface,
      parentGestureRef,
      dragGestureHostActive,
    ],
  );
  const plannerExtraData = useMemo(
    () => ({
      agents,
      selectedAgent,
      workspaceStates,
      openTasks,
      openSurface,
      parentGestureRef,
      dragGestureHostActive,
    }),
    [
      agents,
      selectedAgent,
      workspaceStates,
      openTasks,
      openSurface,
      parentGestureRef,
      dragGestureHostActive,
    ],
  );
  if (query.isPending) return <Text style={styles.hint}>{t("swarm.sidebar.loadingAgents")}</Text>;
  if (query.isError)
    return (
      <View>
        <Text style={styles.hint}>{query.error.message}</Text>
        <RetryButton onRetry={retry}>{t("common.actions.retry")}</RetryButton>
      </View>
    );
  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{t("swarm.sidebar.planners")}</Text>
      </View>
      <DraggableList
        testID={`swarm-planner-list-${plugin.serverId}`}
        data={orderedPlanners}
        keyExtractor={agentKeyExtractor}
        renderItem={renderPlanner}
        onDragEnd={onDragEnd}
        extraData={plannerExtraData}
        scrollEnabled={false}
        useDragHandle
        nestable={isNative}
        simultaneousGestureRef={parentGestureRef}
        gestureHostPresented={dragGestureHostActive}
        containerStyle={styles.members}
      />
      {planners.length === 0 ? (
        <Text style={styles.hint}>{t("swarm.sidebar.noPlanners")}</Text>
      ) : null}
    </View>
  );
}

function RetryButton({ onRetry, children }: { onRetry: () => void; children: ReactNode }) {
  const retry = useCallback(onRetry, [onRetry]);
  return (
    <Button variant="ghost" size="sm" onPress={retry}>
      {children}
    </Button>
  );
}

export function SwarmSidebar({
  children,
  parentGestureRef,
  dragGestureHostActive,
}: SwarmSidebarGestureProps & { children: ReactNode }) {
  const { t } = useTranslation();
  const { mode, setMode } = useSwarmSidebar();
  const installations = usePluginInstallations("paseo-swarm");
  const nativeScrollGestureProps = useMemo(
    () => (parentGestureRef ? ({ simultaneousHandlers: parentGestureRef } as object) : undefined),
    [parentGestureRef],
  );
  const rosterContent = (
    <>
      {installations.map((plugin) => (
        <HostRoster
          key={plugin.serverId}
          plugin={plugin}
          parentGestureRef={parentGestureRef}
          dragGestureHostActive={dragGestureHostActive}
        />
      ))}
      {installations.length === 0 ? (
        <Text style={styles.hint}>{t("swarm.sidebar.connectHost")}</Text>
      ) : null}
    </>
  );
  const swarmList = isNative ? (
    <NestableScrollContainer
      {...nativeScrollGestureProps}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      testID="swarm-sidebar-list"
    >
      {rosterContent}
    </NestableScrollContainer>
  ) : (
    <ScrollView
      style={styles.list}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      testID="swarm-sidebar-list"
    >
      {rosterContent}
    </ScrollView>
  );
  return (
    <View style={styles.container}>
      <View style={styles.picker}>
        <SegmentedControl
          options={modes.map((option) => ({
            value: option.value,
            testID: option.testID,
            label: t(
              option.value === "classical" ? "swarm.sidebar.classical" : "swarm.sidebar.swarm",
            ),
          }))}
          value={mode}
          onValueChange={setMode}
          size="xs"
          testID="swarm-sidebar-mode"
        />
      </View>
      {mode === "classical" ? children : swarmList}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  list: { flex: 1 },
  // Keep the Swarm list in the same outer rail as Classical. The rows below intentionally
  // reuse the same 8px content inset instead of compensating with per-row padding.
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  picker: { padding: theme.spacing[2] },
  sectionHeader: {
    minHeight: 36,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    justifyContent: "center",
  },
  sectionTitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  members: { width: "100%" },
  projectRow: {
    position: "relative",
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  projectRowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  projectRowSelected: { backgroundColor: theme.colors.surfaceSidebarSelected },
  projectRowPressed: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
  },
  projectRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  projectTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
  projectTrailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
  projectIconActionButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  workspaceRow: {
    position: "relative",
    minHeight: 36,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  workspaceRowSelected: { backgroundColor: theme.colors.surfaceSidebarSelected },
  workspaceRowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  workspaceRowPressed: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
  },
  // Row selection is a sibling of its controls so menu/portal presses cannot activate it.
  rowSelectionTarget: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: theme.borderRadius.lg,
  },
  workspaceRowMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  supervisorStatusSlot: {
    width: theme.iconSize.md,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  workspaceTitle: {
    color: theme.colors.foreground,
    opacity: 0.76,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    flex: 1,
    minWidth: 0,
  },
  teamTrigger: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  rosterAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rosterActionText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  rosterCard: { width: 220, padding: theme.spacing[2] },
  rosterTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    padding: theme.spacing[2],
  },
  rosterEntry: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rosterEntryText: { flex: 1, minWidth: 0 },
  rosterStatusSlot: {
    width: 14,
    height: 14,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  rosterEntryMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rosterName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  rosterMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
}));
