import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  Armchair,
  ChevronDown,
  ChevronRight,
  Clock,
  SquareArrowOutUpRight,
} from "lucide-react-native";
import { useShallow } from "zustand/shallow";
import { Button } from "@/components/ui/button";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Composer } from "@/composer";
import { ComposerDock } from "@/composer/dock";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { MessagePayload } from "@/composer/types";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isNative } from "@/constants/platform";
import { KeyboardTranslateView } from "@/keyboard/shift";
import { AgentChatRouteProvider, type AgentChatRoute } from "@/panels/agent-chat-route";
import { AgentPanelContent } from "@/panels/agent-panel";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { RetainedChatContent } from "@/panels/retained-chat-content";
import { useInstalledPlugin } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { formatTimeAgo } from "@/utils/time";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { SwarmCcLine } from "./cc-line";
import { openSwarmTasks } from "./navigation";
import { useSwarmRoster, useSwarmSeat, type SeatDelivery, type SwarmSeat } from "./roster";
import { useSeatAgentTimeline } from "./seat-agent-timeline";
import { sendSeatMail, seatRecipient, useUndeliveredSeatMail } from "./seat-mail";
import { defaultSwarmCc } from "./task-model";
import {
  latestHandover,
  seatConversationAgentId,
  seatOccupants,
  type SeatHandover,
  type SeatMail,
  type SeatOccupant,
} from "./seat-model";

export const ThemedSeatIcon = withUnistyles(Armchair);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedClock = withUnistyles(Clock);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// A seat's conversation: the person talks to the seat, and the seat's current occupant answers.
// Sends go through the seat's mailbox, so they reach whichever agent holds the seat when they are
// delivered, and an empty seat starts its agent with the first one.
export function SeatConversation({
  serverId,
  seatId,
  workspaceId,
  isPaneFocused,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  seatId: string;
  workspaceId: string | null;
  isPaneFocused: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const plugin = useInstalledPlugin(serverId, "paseo-swarm");
  const { seat, deliveries, isPending, error } = useSwarmSeat(plugin, seatId);
  if (!plugin) return <SeatMessage text={t("swarm.tasks.swarmUnavailable")} />;
  if (!seat) {
    if (isPending) return <SeatMessage text={t("swarm.seat.loading")} />;
    return <SeatMessage text={error?.message ?? t("swarm.seat.missing")} />;
  }
  return (
    <SeatConversationContent
      plugin={plugin}
      seat={seat}
      deliveries={deliveries}
      workspaceId={workspaceId}
      isPaneFocused={isPaneFocused}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

const NO_CC: string[] = [];

// Who the person's messages to the seat are copied to: the seat's manager by default, so steering
// a seat directly does not leave its manager out. Removing it holds for this conversation until
// the default is offered again.
function useSeatCc(plugin: InstalledPlugin, seat: SwarmSeat) {
  const roster = useSwarmRoster(plugin).data;
  const recipient = seatRecipient(seat);
  const supported = roster?.features?.includes("cc") ?? false;
  const defaultCc = useMemo(
    () => (supported && roster ? defaultSwarmCc(roster.agents, recipient) : NO_CC),
    [recipient, roster, supported],
  );
  const [chosen, setChosen] = useState<{ seatId: string; cc: string[] } | null>(null);
  const cc = chosen?.seatId === seat.id ? chosen.cc : defaultCc;
  const remove = useCallback(
    (name: string) => setChosen({ seatId: seat.id, cc: cc.filter((entry) => entry !== name) }),
    [cc, seat.id],
  );
  const restore = useCallback(() => setChosen(null), []);
  return { supported, cc, defaultCc, remove, restore };
}

function SeatConversationContent({
  plugin,
  seat,
  deliveries,
  workspaceId,
  isPaneFocused,
  onOpenWorkspaceFile,
}: {
  plugin: InstalledPlugin;
  seat: SwarmSeat;
  deliveries: SeatDelivery[];
  workspaceId: string | null;
  isPaneFocused: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const occupants = useMemo(() => seatOccupants(seat), [seat]);
  const currentAgentId = seatConversationAgentId(seat);
  const [viewedAgentId, setViewedAgentId] = useState<string | null>(null);
  // An occupant you were reading that is gone from the list, or became current, falls back.
  const viewedPast = occupants.find(
    (occupant) => !occupant.current && occupant.paseoAgentId === viewedAgentId,
  );
  const shownAgentId = viewedPast?.paseoAgentId ?? currentAgentId;
  const shownOccupant = occupants.find((occupant) => occupant.paseoAgentId === shownAgentId);
  useSeatAgentTimeline(plugin.serverId, workspaceId ? shownAgentId : null, active);
  const handover = useMemo(() => latestHandover(seat), [seat]);
  const mail = useUndeliveredSeatMail(plugin, seat, active);
  const name = seatRecipient(seat);

  const copies = useSeatCc(plugin, seat);
  const seatRef = useRef(seat);
  seatRef.current = seat;
  const ccRef = useRef(copies.cc);
  ccRef.current = copies.cc;
  const submit = useCallback(
    async ({ text, attachments }: MessagePayload) => {
      if (attachments.length > 0) throw new Error(t("swarm.seat.textOnly"));
      await sendSeatMail(plugin, seatRef.current, text, ccRef.current);
    },
    [plugin, t],
  );
  const showCurrent = useCallback(() => setViewedAgentId(null), []);
  const aboveInput = useMemo(
    () => (
      <>
        <SeatComposerNotices pending={seat.pending ?? null} mail={mail} />
        {copies.supported ? (
          <View style={styles.ccLine}>
            <SwarmCcLine
              recipient={name}
              cc={copies.cc}
              defaultCc={copies.defaultCc}
              onRemove={copies.remove}
              onRestore={copies.restore}
            />
          </View>
        ) : null}
      </>
    ),
    [copies, mail, name, seat.pending],
  );
  const route = useMemo<AgentChatRoute>(
    () => ({
      submit,
      placeholder: t("swarm.seat.placeholder", { name }),
      aboveInput,
      composerReplacement: viewedPast ? (
        <PastStintBar occupant={viewedPast} onShowCurrent={showCurrent} />
      ) : undefined,
    }),
    [aboveInput, name, showCurrent, submit, t, viewedPast],
  );

  return (
    <View style={styles.screen} testID={`swarm-seat-${seat.id}`}>
      <SeatHeader
        serverId={plugin.serverId}
        seat={seat}
        occupants={occupants}
        shown={shownOccupant ?? null}
        onShow={setViewedAgentId}
      />
      {handover && !viewedPast ? (
        <HandoverRow handover={handover} onShow={setViewedAgentId} />
      ) : null}
      <SeatDeliveries
        serverId={plugin.serverId}
        workspaceId={seat.workspaceId ?? workspaceId}
        deliveries={deliveries}
      />
      {shownAgentId && workspaceId ? (
        <AgentChatRouteProvider value={route}>
          <RetainedChatContent>
            <AgentPanelContent
              key={shownAgentId}
              serverId={plugin.serverId}
              workspaceId={workspaceId}
              agentId={shownAgentId}
              isPaneFocused={isPaneFocused}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          </RetainedChatContent>
        </AgentChatRouteProvider>
      ) : (
        <EmptySeat
          serverId={plugin.serverId}
          seat={seat}
          workspaceId={workspaceId}
          isPaneFocused={isPaneFocused}
          submit={submit}
          aboveInput={aboveInput}
        />
      )}
    </View>
  );
}

// Results the seat delivered to the person, newest first, so a reply the seat did not repeat in
// its own words is still in reach of its conversation. Each opens its Task, which shows it in full.
function SeatDeliveries({
  serverId,
  workspaceId,
  deliveries,
}: {
  serverId: string;
  workspaceId: string | null;
  deliveries: SeatDelivery[];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  if (deliveries.length === 0) return null;
  const shown = expanded ? deliveries : deliveries.slice(0, 1);
  return (
    <View style={styles.deliveries} testID="swarm-seat-deliveries">
      <View style={styles.deliveriesHeader}>
        <Text style={styles.deliveriesTitle}>{t("swarm.seat.deliveries")}</Text>
        {deliveries.length > 1 ? (
          <Button
            variant="ghost"
            size="xs"
            leftIcon={expanded ? ChevronDown : ChevronRight}
            onPress={toggle}
          >
            {String(deliveries.length)}
          </Button>
        ) : null}
      </View>
      {shown.map((delivery) => (
        <SeatDeliveryRow
          key={delivery.activityId}
          serverId={serverId}
          workspaceId={workspaceId}
          delivery={delivery}
        />
      ))}
    </View>
  );
}

function SeatDeliveryRow({
  serverId,
  workspaceId,
  delivery,
}: {
  serverId: string;
  workspaceId: string | null;
  delivery: SeatDelivery;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => {
    if (!workspaceId) return;
    openSwarmTasks({ serverId, workspaceId, agentName: "", taskId: delivery.taskId });
  }, [delivery.taskId, serverId, workspaceId]);
  return (
    <View style={styles.delivery} testID={`swarm-seat-delivery-${delivery.activityId}`}>
      <View style={styles.deliveriesHeader}>
        <Text style={styles.deliveryLabel}>
          {delivery.taskState === "open" ? t("swarm.tasks.stageResult") : t("swarm.tasks.result")}
          {delivery.as === "cc" ? ` · ${t("swarm.seat.deliveryCopied")}` : ""}
          {` · ${formatTimeAgo(new Date(delivery.createdAt))}`}
        </Text>
        {workspaceId ? (
          <Button
            variant="ghost"
            size="xs"
            leftIcon={SquareArrowOutUpRight}
            onPress={open}
            testID={`swarm-seat-delivery-open-${delivery.activityId}`}
          >
            {t("swarm.seat.openTask", { title: delivery.taskTitle })}
          </Button>
        ) : null}
      </View>
      <Text style={styles.deliveryBody} numberOfLines={4}>
        {delivery.body}
      </Text>
    </View>
  );
}

function SeatMessage({ text }: { text: string }) {
  return (
    <View style={styles.screen}>
      <Text style={styles.message}>{text}</Text>
    </View>
  );
}

function occupantLabel(
  t: ReturnType<typeof useTranslation>["t"],
  occupant: Pick<SeatOccupant, "number" | "provider">,
) {
  return occupant.provider
    ? t("swarm.seat.occupantWithProvider", {
        number: occupant.number,
        provider: occupant.provider,
      })
    : t("swarm.seat.occupant", { number: occupant.number });
}

function occupantDescription(
  t: ReturnType<typeof useTranslation>["t"],
  seat: SwarmSeat,
  occupant: SeatOccupant,
) {
  if (occupant.current) {
    return seat.paseoAgentId ? t("swarm.seat.inSeat") : t("swarm.seat.arriving");
  }
  return t("swarm.seat.left", {
    time: occupant.retiredAt ? formatTimeAgo(new Date(occupant.retiredAt)) : "",
    reason: occupant.reason ?? "",
  });
}

function SeatHeader({
  serverId,
  seat,
  occupants,
  shown,
  onShow,
}: {
  serverId: string;
  seat: SwarmSeat;
  occupants: SeatOccupant[];
  shown: SeatOccupant | null;
  onShow: (paseoAgentId: string | null) => void;
}) {
  const { t } = useTranslation();
  const openAgentTab = useCallback(() => {
    if (!shown) return;
    // A seat's occupant stays its agent after Paseo archives it, so its tab must survive pruning.
    navigateToAgent({
      serverId,
      agentId: shown.paseoAgentId,
      workspaceId: seat.workspaceId,
      pin: true,
    });
  }, [seat.workspaceId, serverId, shown]);
  return (
    <View style={styles.header}>
      <ThemedSeatIcon size={ICON_SIZE.md} uniProps={mutedColorMapping} />
      <View style={styles.headerTitle}>
        <Text style={styles.seatName} numberOfLines={1}>
          {seatRecipient(seat)}
        </Text>
        <Text style={styles.seatRole} numberOfLines={1}>
          {[t(`swarm.roles.${seat.roleClass}`), seat.role].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {occupants.length > 0 ? (
        <DropdownMenu compactMode="sheet">
          <DropdownMenuTrigger
            accessibilityRole="button"
            accessibilityLabel={t("swarm.seat.occupants")}
            style={styles.occupantsTrigger}
            testID="swarm-seat-occupants"
          >
            <Text style={styles.occupantsLabel} numberOfLines={1}>
              {shown ? occupantLabel(t, shown) : t("swarm.seat.noAgent")}
            </Text>
            <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="bottom"
            minWidth={240}
            sheetTitle={t("swarm.seat.occupants")}
          >
            {occupants.map((occupant) => (
              <OccupantItem
                key={occupant.paseoAgentId}
                seat={seat}
                occupant={occupant}
                selected={occupant.paseoAgentId === shown?.paseoAgentId}
                onShow={onShow}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Text style={styles.occupantsLabel}>{t("swarm.seat.noAgent")}</Text>
      )}
      {shown ? (
        <Button
          variant="ghost"
          size="xs"
          leftIcon={SquareArrowOutUpRight}
          accessibilityLabel={t("swarm.seat.openAgentTab", { occupant: occupantLabel(t, shown) })}
          onPress={openAgentTab}
          testID="swarm-seat-open-agent"
        />
      ) : null}
    </View>
  );
}

function OccupantItem({
  seat,
  occupant,
  selected,
  onShow,
}: {
  seat: SwarmSeat;
  occupant: SeatOccupant;
  selected: boolean;
  onShow: (paseoAgentId: string | null) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(
    () => onShow(occupant.current ? null : occupant.paseoAgentId),
    [occupant, onShow],
  );
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      description={occupantDescription(t, seat, occupant)}
      onSelect={handleSelect}
      testID={`swarm-seat-occupant-${occupant.number}`}
    >
      {occupantLabel(t, occupant)}
    </DropdownMenuItem>
  );
}

// Where the current occupant took the seat over, and what it actually knows: a new agent has
// none of the earlier conversation, and a returning one remembers only its own.
function HandoverRow({
  handover,
  onShow,
}: {
  handover: SeatHandover;
  onShow: (paseoAgentId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const showPrevious = useCallback(
    () => onShow(handover.fromAgentId),
    [handover.fromAgentId, onShow],
  );
  const time = formatTimeAgo(new Date(handover.at));
  const values = { from: handover.from, to: handover.to, time, reason: handover.reason };
  return (
    <View style={styles.handover} testID="swarm-seat-handover">
      <Text style={styles.handoverText}>
        {handover.returning
          ? t("swarm.seat.handover.returning", values)
          : t("swarm.seat.handover.new", values)}
      </Text>
      <View style={styles.handoverActions}>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={expanded ? ChevronDown : ChevronRight}
          onPress={toggle}
          testID="swarm-seat-handover-toggle"
        >
          {t("swarm.seat.handover.given")}
        </Button>
        <Button variant="ghost" size="xs" onPress={showPrevious}>
          {t("swarm.seat.handover.showPrevious", { from: handover.from })}
        </Button>
      </View>
      {expanded ? (
        <Text style={styles.handoverDetail}>
          {handover.returning
            ? t("swarm.seat.handover.givenReturning", values)
            : t("swarm.seat.handover.givenNew", values)}
        </Text>
      ) : null}
    </View>
  );
}

// Stands in for the composer while you read an earlier occupant, on the composer's own rail: that
// occupant no longer holds the seat, so nothing typed here could reach it.
function PastStintBar({
  occupant,
  onShowCurrent,
}: {
  occupant: SeatOccupant;
  onShowCurrent: () => void;
}) {
  const { t } = useTranslation();
  return (
    <KeyboardTranslateView style={styles.pastContainer}>
      <View style={styles.pastRail}>
        <View style={styles.pastBar} testID="swarm-seat-past">
          <Text style={styles.pastText}>
            {t("swarm.seat.viewingPast", {
              number: occupant.number,
              time: occupant.retiredAt ? formatTimeAgo(new Date(occupant.retiredAt)) : "",
            })}
          </Text>
          <Button variant="secondary" size="sm" onPress={onShowCurrent} testID="swarm-seat-current">
            {t("swarm.seat.backToCurrent")}
          </Button>
        </View>
      </View>
    </KeyboardTranslateView>
  );
}

// What the next message will do to the seat, and the person's mail the occupant has not seen yet.
// They sit on the composer's rail, styled like the composer's own queue.
function SeatComposerNotices({
  pending,
  mail,
}: {
  pending: { kind: string; reason: string } | null;
  mail: SeatMail[];
}) {
  const { t } = useTranslation();
  if (!pending && mail.length === 0) return null;
  return (
    <View style={styles.notices}>
      {mail.map((message) => (
        <View key={message.id} style={styles.mailRow} testID={`swarm-seat-mail-${message.id}`}>
          <Text style={styles.mailWords} numberOfLines={2} ellipsizeMode="tail">
            {message.words}
          </Text>
          <Text
            style={message.status === "failed" ? styles.mailFailed : styles.mailStatus}
            accessibilityRole={message.status === "failed" ? "alert" : undefined}
            numberOfLines={2}
          >
            {message.status === "failed"
              ? t("swarm.seat.mailFailed", { reason: message.lastError ?? "" })
              : t("swarm.seat.mailQueued")}
          </Text>
        </View>
      ))}
      {pending ? (
        <View style={styles.pending} testID="swarm-seat-pending">
          <ThemedClock size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          <Text style={styles.pendingText}>
            {t("swarm.seat.pending", { reason: pending.reason })}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function EmptySeat({
  serverId,
  seat,
  workspaceId,
  isPaneFocused,
  submit,
  aboveInput,
}: {
  serverId: string;
  seat: SwarmSeat;
  workspaceId: string | null;
  isPaneFocused: boolean;
  submit: (payload: MessagePayload) => Promise<void>;
  aboveInput: ReactNode;
}) {
  const { t } = useTranslation();
  const draftKey = `swarm-seat:${serverId}:${seat.id}`;
  const draft = useAgentInputDraft({ draftKey });
  const name = seatRecipient(seat);
  return (
    <View style={styles.empty}>
      <ComposerDock centered>
        <View style={styles.emptyBody}>
          <Text style={styles.emptyTitle}>{t("swarm.seat.startsSeat", { name })}</Text>
          <Text style={styles.message}>{t("swarm.seat.startsHint")}</Text>
        </View>
        <View style={styles.composer}>
          <Composer
            agentId={draftKey}
            serverId={serverId}
            workspaceId={workspaceId}
            isPaneFocused={isPaneFocused}
            onSubmitMessage={submit}
            queueWhileAgentRunning={false}
            placeholder={t("swarm.seat.placeholder", { name })}
            blurOnSubmit={isNative}
            textSource={draft.textSource}
            onChangeText={draft.editText}
            textReplacement={draft.textReplacement}
            attachments={draft.attachments}
            onChangeAttachments={draft.setAttachments}
            cwd=""
            clearDraft={draft.clear}
            aboveInput={aboveInput}
            autoFocus
          />
        </View>
      </ComposerDock>
    </View>
  );
}

function SwarmSeatPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  if (target.kind !== "swarm_seat") return null;
  return (
    <SeatConversation
      serverId={serverId}
      seatId={target.seatId}
      workspaceId={workspaceId}
      isPaneFocused={isInteractive}
      onOpenWorkspaceFile={openFileInWorkspace}
    />
  );
}

function useSeatPanelDescriptor(
  target: { kind: "swarm_seat"; seatId: string },
  context: { serverId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const plugin = useInstalledPlugin(context.serverId, "paseo-swarm");
  const { seat } = useSwarmSeat(plugin, target.seatId);
  const agentId = seat ? seatConversationAgentId(seat) : null;
  const state = useSessionStore(
    useShallow((store) => {
      const session = store.sessions[context.serverId];
      const agent = agentId
        ? (session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId) ?? null)
        : null;
      return {
        status: agent?.status ?? null,
        pendingPermissionCount: agent?.pendingPermissions.length ?? 0,
        requiresAttention: agent?.requiresAttention ?? false,
        attentionReason: agent?.attentionReason ?? null,
        isTurnActive: agentId ? selectAgentTurnPresentation(session, agentId).isActive : false,
      };
    }),
  );
  const label = seat ? seatRecipient(seat) : t("swarm.seat.tabLabel");
  return {
    label,
    subtitle: t("swarm.seat.tabLabel"),
    tooltip: label,
    titleState: seat ? "ready" : "loading",
    icon: ThemedSeatIcon,
    statusBucket: state.status
      ? deriveSidebarStateBucket({
          status: state.isTurnActive ? "running" : state.status,
          pendingPermissionCount: state.pendingPermissionCount,
          requiresAttention: state.requiresAttention,
          attentionReason: state.attentionReason,
        })
      : null,
  };
}

export const swarmSeatPanelRegistration = definePanel("swarm_seat", {
  component: SwarmSeatPanel,
  useDescriptor: useSeatPanelDescriptor,
});

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
  },
  seatName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  seatRole: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // As tall as the xs button beside it, so the row reads as one line of controls. A long provider
  // name shrinks the label, not the seat name.
  occupantsTrigger: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    maxWidth: "50%",
    minHeight: buttonControlHeight.xs,
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  occupantsLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  handover: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  handoverText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  handoverActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  handoverDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  pastContainer: {
    alignItems: "center",
    width: "100%",
    padding: theme.spacing[4],
  },
  pastRail: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  pastBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  pastText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  ccLine: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  deliveries: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  deliveriesHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  deliveriesTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  delivery: {
    gap: theme.spacing[1],
  },
  deliveryLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  deliveryBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  notices: {
    gap: theme.spacing[2],
  },
  mailRow: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  mailWords: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  mailStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  mailFailed: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  pending: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  pendingText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    flex: 1,
    minHeight: 0,
  },
  emptyBody: {
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[4],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  composer: {
    width: "100%",
    flexShrink: 1,
  },
}));
