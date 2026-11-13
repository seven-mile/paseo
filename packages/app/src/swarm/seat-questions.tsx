import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { useSessionStore } from "@/stores/session-store";
import {
  seatQuestions,
  type SeatQuestion,
  type SwarmTaskAgent,
  type SwarmTaskReference,
} from "./task-model";

export function useSeatQuestions(
  serverId: string,
  seats: readonly SwarmTaskAgent[],
): SeatQuestion[] {
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const details = useSessionStore((state) => state.sessions[serverId]?.agentDetails);
  return useMemo(
    () =>
      seatQuestions(
        seats,
        (paseoAgentId) =>
          (agents?.get(paseoAgentId) ?? details?.get(paseoAgentId))?.pendingPermissions,
      ),
    [agents, details, seats],
  );
}

function SeatQuestionItem({
  question,
  onOpen,
}: {
  question: SeatQuestion;
  onOpen: (reference: SwarmTaskReference) => void;
}) {
  const open = useCallback(() => onOpen(question.reference), [onOpen, question.reference]);
  return (
    <DropdownMenuItem
      description={question.question}
      onSelect={open}
      testID={`swarm-seat-question-${question.requestId}`}
    >
      {question.seatName}
    </DropdownMenuItem>
  );
}

// Lists provider questions next to the Swarm choices awaiting a reply. Picking one opens the seat,
// where the question is answered as usual.
export function SeatQuestionsBadge({
  questions,
  onOpen,
}: {
  questions: readonly SeatQuestion[];
  onOpen: (reference: SwarmTaskReference) => void;
}) {
  const { t } = useTranslation();
  if (questions.length === 0) return null;
  const label = t("swarm.tasks.agentQuestions", { count: questions.length });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.trigger}
        accessibilityLabel={label}
        testID="swarm-seat-questions"
      >
        <StatusBadge variant="warning" label={label} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={320}>
        {questions.map((question) => (
          <SeatQuestionItem
            key={`${question.reference.paseoAgentId}:${question.requestId}`}
            question={question}
            onOpen={onOpen}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create(() => ({
  trigger: {
    alignSelf: "flex-start",
  },
}));
