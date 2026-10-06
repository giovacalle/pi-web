// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageActionAvailabilityContext, MessageActionContext, MessageActionContribution } from "../../../plugin-api";
import { corePlugin } from "../plugins/core";
import { PluginRegistry } from "../plugins/registry";
import type { ChatLine } from "./shared";
import { ChatView } from "./ChatView";

const base = {
  machine: { id: "local", name: "Local", kind: "local" },
  session: { id: "session-1", cwd: "/repo", archived: false, pending: false, busy: false },
} as const;

function invocation(input: MessageActionAvailabilityContext): MessageActionContext {
  return {
    ...input,
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    navigate: vi.fn(),
    projects: { machineId: "local", listProjects: vi.fn(), suggestDirectories: vi.fn() },
    history: { fork: vi.fn(), goBack: vi.fn() },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(contributions?: MessageActionContribution[]) {
  const registry = new PluginRegistry();
  await registry.register({ id: "core", plugin: corePlugin });
  if (contributions !== undefined) await registry.register({ id: "custom", plugin: {
    apiVersion: 4, name: "Custom", activate: () => ({ contributions: { messageActions: contributions } }),
  } });
  const view = new ChatView();
  view.sessionId = base.session.id;
  view.messages = [{ role: "user", entryId: "entry-1", parts: [{ type: "text", text: "Hello" }] }];
  view.messageActionContext = base;
  view.messageActions = registry.getMessageActions("local");
  const context = invocation({ ...base, message: { entryId: "entry-1", role: "user", text: "Hello" } });
  view.onMessageAction = (input, id) => registry.runMessageAction(id, input, () => context);
  document.body.append(view);
  await view.updateComplete;
  return { view, registry, context };
}

function button(view: ChatView, label: string): HTMLButtonElement {
  const result = buttons(view).find((button) => button.getAttribute("aria-label") === label);
  if (result === undefined) throw new Error(`Missing message action ${label}`);
  return result;
}

function buttons(view: ChatView) {
  return Array.from(view.renderRoot.querySelectorAll<HTMLButtonElement>(".msg-action"));
}

async function settle(view: ChatView) {
  await view.updateComplete;
  await view.updateComplete;
}

describe("plugin-defined transcript message actions", () => {
  it.each([
    ["Clone session from this message", "fork", "Are you sure you want to fork this session?"],
    ["Go back to this message", "goBack", "Are you sure you want to go back to this message?"],
  ] as const)("preserves core confirmation for %s through the public callback", async (label, action, copy) => {
    const { view, context } = await mount();
    expect(buttons(view).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Clone session from this message", "Go back to this message", "Copy user message",
    ]);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    button(view, label).click();
    await settle(view);
    expect(confirm).toHaveBeenCalledWith(copy);
    expect(context.history[action]).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    button(view, label).click();
    await settle(view);
    expect(context.history[action]).toHaveBeenCalledOnce();
  });

  it("runs arbitrary plugin workflows without a host confirmation and filters availability per message", async () => {
    const run = vi.fn<MessageActionContribution["run"]>();
    const { view, context } = await mount([
      { id: "quote", title: "Quote", visible: ({ message }) => message.role === "user", enabled: ({ message }) => message.text !== "Blocked", run },
      { id: "hidden", title: "Hidden", visible: () => false, run },
    ]);
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    button(view, "Quote").click();
    await settle(view);
    expect(run).toHaveBeenCalledExactlyOnceWith(context);
    expect(confirm).not.toHaveBeenCalled();
    expect(buttons(view).some((button) => button.title === "Hidden")).toBe(false);
    view.messages = [{ role: "user", entryId: "entry-2", parts: [{ type: "text", text: "Blocked" }] }];
    await settle(view);
    expect(button(view, "Quote").disabled).toBe(true);
    view.messages = [{ role: "assistant", entryId: "entry-3", parts: [{ type: "text", text: "Answer" }] }];
    await settle(view);
    expect(buttons(view).some((button) => button.title === "Quote")).toBe(false);
  });

  it("uses original message identities and displayed roles across paginated skill headers", async () => {
    const { view } = await mount([{ id: "skill", title: "Inspect skill", visible: ({ message }) => message.role === "skill", run: () => undefined }]);
    view.messageStart = 20;
    view.messages = [{ role: "assistant", entryId: "skill-entry", parts: [{ type: "skillRead", name: "example", path: "/skills/example/SKILL.md" }] }];
    view.onMessageAction = vi.fn(() => Promise.resolve());
    await settle(view);
    expect(buttons(view).map((button) => button.title)).toEqual(["Inspect skill"]);
    button(view, "Inspect skill").click();
    await settle(view);
    expect(view.onMessageAction).toHaveBeenCalledWith({ ...base, message: { entryId: "skill-entry", role: "skill", text: "" } }, "custom:skill");
  });

  it("does not offer contributed actions without a durable entry", async () => {
    const { view } = await mount();
    view.messages = [{ role: "assistant", parts: [{ type: "text", text: "Streaming" }] }];
    await view.updateComplete;
    expect(buttons(view).map((button) => button.title)).toEqual(["Copy message"]);
  });

  it("disables core history actions while busy but leaves Copy and other plugin policy independent", async () => {
    const { view } = await mount([{ id: "note", title: "Note", run: () => undefined }]);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    view.messageActionContext = { ...base, session: { ...base.session, busy: true } };
    await settle(view);
    button(view, "Clone session from this message").click();
    expect(confirm).not.toHaveBeenCalled();
    expect(button(view, "Copy user message").disabled).toBe(false);
    expect(button(view, "Note").disabled).toBe(false);
    view.messageActionContext = base;
    view.onMessageAction = vi.fn(() => Promise.reject(new Error("History changed")));
    await settle(view);
    button(view, "Go back to this message").click();
    await settle(view);
    expect(view.renderRoot.querySelector('[role="alert"]')?.textContent).toBe("History changed");
  });

  it("does not repeat historical availability checks or fetch on unrelated stream/render updates", async () => {
    const visible = vi.fn<NonNullable<MessageActionContribution["visible"]>>(() => true);
    const enabled = vi.fn<NonNullable<MessageActionContribution["enabled"]>>(() => true);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { view, registry } = await mount([{ id: "note", title: "Note", visible, enabled, run: () => undefined }]);
    const history = view.messages[0];
    if (history === undefined) throw new Error("Expected historical message");
    expect(visible).toHaveBeenCalledTimes(1);
    for (const text of ["One", "Two", "Three"]) {
      view.messages = [history, { role: "assistant", parts: [{ type: "text", text }] }];
      // The app makes new small snapshots/lists on each render; identities of
      // the registered actions and unchanged transcript lines remain stable.
      view.messageActionContext = { machine: { ...base.machine }, session: { ...base.session } };
      view.messageActions = registry.getMessageActions("local");
      await settle(view);
    }
    expect(visible).toHaveBeenCalledTimes(1);
    expect(enabled).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    const updated: ChatLine = { ...history, parts: [{ type: "text", text: "Changed" }] };
    view.messages = [updated];
    await settle(view);
    expect(visible).toHaveBeenCalledTimes(2);
    expect(visible).toHaveBeenLastCalledWith(expect.objectContaining({ message: { entryId: "entry-1", role: "user", text: "Changed" } }));
    view.messageActionContext = { ...base, session: { ...base.session, archived: true } };
    await settle(view);
    expect(enabled).toHaveBeenCalledTimes(3);
    expect(button(view, "Clone session from this message").disabled).toBe(true);
  });
});
