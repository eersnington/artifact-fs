import { actor, event, setup } from "rivetkit";
import type { AgentState } from "./events.js";

export const workspaceActor = actor({
  state: {
    latest: null as AgentState | null,
  },
  events: {
    changed: event<AgentState>(),
  },
  actions: {
    record: (c, state: AgentState) => {
      c.state.latest = state;
      c.broadcast("changed", state);
      return state;
    },
    get: (c) => c.state.latest,
  },
});

export const registry = setup({
  use: {
    workspaceActor,
  },
});
