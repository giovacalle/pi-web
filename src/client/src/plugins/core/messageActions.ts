import { html } from "lit";
import type { MessageActionAvailabilityContext, MessageActionContribution } from "../../../../plugin-api";

export function createCoreMessageActions(): MessageActionContribution[] {
  const historyAction = {
    visible: ({ message }: MessageActionAvailabilityContext) => message.role === "user" || message.role === "assistant",
    enabled: ({ session }: MessageActionAvailabilityContext) => !session.archived && !session.pending && !session.busy,
  };
  return [{
    ...historyAction,
    id: "message.fork",
    title: "Clone session from this message",
    icon: html`<span class="msg-fork-icon" aria-hidden="true">⑂</span>`,
    run: async ({ history }) => {
      if (window.confirm("Are you sure you want to fork this session?")) await history.fork();
    },
  }, {
    ...historyAction,
    id: "message.back",
    title: "Go back to this message",
    icon: html`<svg aria-hidden="true" width="16" height="16" viewBox="-3 -3 30 30" fill="none" stroke="currentColor" stroke-width="0.85" stroke-linecap="round" stroke-linejoin="round"><path vector-effect="non-scaling-stroke" d="M4 5h11a6 6 0 0 1 0 12H4m5-5-5 5 5 5" /></svg>`,
    run: async ({ history }) => {
      if (window.confirm("Are you sure you want to go back to this message?")) await history.goBack();
    },
  }];
}
