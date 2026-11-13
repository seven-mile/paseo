import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

// What the person already dismissed in each seat's view, keyed by host and seat: the newest
// result they saw and the handover they closed. A newer result or handover shows again.
const seenSchema = z.object({
  results: z.record(z.string(), z.string()),
  handovers: z.record(z.string(), z.string()),
});
type Seen = z.infer<typeof seenSchema>;

interface SeatSeenStore extends Seen {
  seeResult: (seatKey: string, activityId: string) => void;
  seeHandover: (seatKey: string, handoverKey: string) => void;
}

export const useSeatSeen = create<SeatSeenStore>()(
  persist(
    (set) => ({
      results: {},
      handovers: {},
      seeResult: (seatKey, activityId) =>
        set((state) => ({ results: { ...state.results, [seatKey]: activityId } })),
      seeHandover: (seatKey, handoverKey) =>
        set((state) => ({ handovers: { ...state.handovers, [seatKey]: handoverKey } })),
    }),
    {
      name: "swarm-seat-seen",
      storage: createValidatedPersistStorage(AsyncStorage, seenSchema),
      partialize: ({ results, handovers }) => ({ results, handovers }),
    },
  ),
);

export function seatSeenKey(serverId: string, seatId: string): string {
  return `${serverId}:${seatId}`;
}
