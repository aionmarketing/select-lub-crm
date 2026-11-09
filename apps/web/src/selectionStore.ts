/**
 * Zustand store for the conversation selected in the Conversas attendant inbox.
 */
import { create } from "zustand";

/**
 * Zustand hook for the conversation selected in the Conversas inbox.
 * @returns `selectedConversationId` and `select` to open or clear the active thread.
 */
export const useSelection = create<{
  selectedConversationId: string | null;
  select: (id: string | null) => void;
}>((set) => ({
  selectedConversationId: null,
  select: (id) => set({ selectedConversationId: id }),
}));
