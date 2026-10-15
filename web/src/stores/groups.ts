import { create } from 'zustand';
import { api } from '../api/client';
import { extractErrorMessage } from '../utils/error';
import type { GroupInfo } from '../types';
import { normalizeGroupInteractionMode } from '../lib/interaction-mode';

export type { GroupInfo };

interface GroupsState {
  groups: Record<string, GroupInfo>;
  adminHostOnlyMode: boolean;
  loading: boolean;
  error: string | null;
  runnerStates: Record<string, 'idle' | 'running'>;
  loadGroups: () => Promise<void>;
  setRunnerState: (chatJid: string, state: 'idle' | 'running') => void;
}

export const useGroupsStore = create<GroupsState>((set) => ({
  groups: {},
  adminHostOnlyMode: false,
  loading: false,
  error: null,
  runnerStates: {},

  loadGroups: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        groups: Record<string, GroupInfo>;
        admin_host_only_mode?: boolean;
      }>('/api/groups');
      const groups = Object.fromEntries(
        Object.entries(data.groups).map(([jid, group]) => [
          jid,
          normalizeGroupInteractionMode(group),
        ]),
      );
      set({
        groups,
        adminHostOnlyMode: data.admin_host_only_mode === true,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: extractErrorMessage(err),
      });
    }
  },

  setRunnerState: (chatJid: string, state: 'idle' | 'running') => {
    set((s) => {
      if (state === 'idle') {
        const { [chatJid]: _, ...rest } = s.runnerStates;
        return { runnerStates: rest };
      }
      return { runnerStates: { ...s.runnerStates, [chatJid]: state } };
    });
  },
}));
