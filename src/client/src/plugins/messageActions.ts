import type { MessageActionAvailabilityContext, MessageActionContribution, MessageActionMessage } from "../../../plugin-api";
import type { ChatLine } from "../components/shared";
import type { WorkspacePluginBinding } from "./types";

export interface RegisteredMessageAction extends MessageActionContribution {
  readonly binding: WorkspacePluginBinding;
  readonly machineId?: string;
}

export interface AvailableMessageAction {
  readonly action: RegisteredMessageAction;
  readonly enabled: boolean;
}

export function messageActionMessage(message: ChatLine, role = message.role): MessageActionMessage | undefined {
  if (message.entryId === undefined) return undefined;
  return Object.freeze({
    entryId: message.entryId,
    role,
    text: message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n"),
  });
}

export function availableMessageActions(
  actions: readonly RegisteredMessageAction[],
  context: MessageActionAvailabilityContext,
): readonly AvailableMessageAction[] {
  return actions.filter((action) => action.visible?.(context) ?? true)
    .map((action) => ({ action, enabled: action.enabled?.(context) ?? true }));
}

/** Transcript projections keep unchanged ChatLine identities across stream updates. */
export class MessageActionAvailabilityCache {
  private inputs = "";
  private actions: readonly RegisteredMessageAction[] = [];
  private messages = new WeakMap<ChatLine, Map<ChatLine["role"], readonly AvailableMessageAction[]>>();

  get(
    message: ChatLine,
    actions: readonly RegisteredMessageAction[],
    context: Omit<MessageActionAvailabilityContext, "message">,
    role = message.role,
  ): readonly AvailableMessageAction[] {
    const inputs = JSON.stringify([context.machine, context.session]);
    if (inputs !== this.inputs || actions.length !== this.actions.length || actions.some((action, index) => action !== this.actions[index])) {
      this.inputs = inputs;
      this.actions = actions;
      this.messages = new WeakMap();
    }
    // Grouping can display one entry under different headers (e.g. assistant
    // thinking and a skill read). Cache each displayed role on the original line.
    const roles = this.messages.get(message) ?? new Map<ChatLine["role"], readonly AvailableMessageAction[]>();
    const cached = roles.get(role);
    if (cached !== undefined) return cached;
    const snapshot = messageActionMessage(message, role);
    const result = snapshot === undefined ? [] : availableMessageActions(actions, { ...context, message: snapshot });
    roles.set(role, result);
    this.messages.set(message, roles);
    return result;
  }
}
