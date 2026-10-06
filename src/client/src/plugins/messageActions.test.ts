import { describe, expect, it, vi } from "vitest";
import type { MessageActionAvailabilityContext, MessageActionContext, MessageActionContribution } from "../../../plugin-api";
import { PluginRegistry } from "./registry";

const input: MessageActionAvailabilityContext = {
  machine: { id: "remote", name: "Remote", kind: "remote" },
  session: { id: "s", cwd: "/repo", archived: false, pending: false, busy: false },
  message: { entryId: "entry", role: "user", text: "Hello" },
};

function plugin(action: MessageActionContribution) {
  return { apiVersion: 4 as const, name: "Message tools", activate: () => ({ contributions: { messageActions: [action] } }) };
}

function context(): MessageActionContext {
  return {
    ...input,
    navigate: vi.fn(), prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    projects: { machineId: "remote", listProjects: vi.fn(), suggestDirectories: vi.fn() },
    history: { fork: vi.fn(), goBack: vi.fn() },
  };
}

describe("message action registry", () => {
  it("qualifies actions, supplies the exact package binding and rechecks click-time availability", async () => {
    let enabled = true;
    const registry = new PluginRegistry();
    const run = vi.fn<MessageActionContribution["run"]>();
    await registry.register({ id: "runtime", sourcePluginId: "source", machineId: "remote", plugin: plugin({ id: "note", title: "Note", enabled: () => enabled, run }) });
    expect(registry.getMessageActions("remote").map((action) => action.id)).toEqual(["runtime:note"]);
    const createContext = vi.fn(() => context());
    enabled = false;
    await registry.runMessageAction("runtime:note", input, createContext);
    expect(createContext).not.toHaveBeenCalled();
    enabled = true;
    await registry.runMessageAction("runtime:note", input, createContext);
    expect(createContext).toHaveBeenCalledExactlyOnceWith({ registrationPluginId: "runtime", sourcePluginId: "source" });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject(input);
    expect(registry.getMessageActions("local")).toEqual([]);
    await registry.dispose();
  });

  it("uses portable/machine-specific precedence, live lifecycle gating and disposal", async () => {
    let active = true;
    const registry = new PluginRegistry({ isContributionEnabled: () => active });
    const run = vi.fn<MessageActionContribution["run"]>();
    const action = { id: "note", title: "Note", run };
    await registry.register({ id: "gateway", machineSpecific: true, plugin: plugin(action) });
    await registry.register({ id: "remote-instance", sourcePluginId: "gateway", machineId: "remote", machineSpecific: true, plugin: plugin(action) });
    expect(registry.getMessageActions("local").map((item) => item.id)).toEqual(["gateway:note"]);
    expect(registry.getMessageActions("remote").map((item) => item.id)).toEqual(["remote-instance:note"]);
    expect(registry.getMessageActions("other")).toEqual([]);
    active = false;
    await registry.runMessageAction("remote-instance:note", input, context);
    expect(run).not.toHaveBeenCalled();
    active = true;
    await registry.dispose();
    expect(registry.getMessageActions("remote")).toEqual([]);
    await registry.runMessageAction("remote-instance:note", input, context);
    expect(run).not.toHaveBeenCalled();
  });

  it("never publishes failed-start or duplicate contributions", async () => {
    const registry = new PluginRegistry();
    const action = { id: "note", title: "Note", run: () => undefined };
    await expect(registry.register({ id: "failed", plugin: {
      ...plugin(action), activate: () => ({ contributions: { messageActions: [action] }, start: () => { throw new Error("start failed"); } }),
    } })).rejects.toThrow("start failed");
    await expect(registry.register({ id: "duplicate", plugin: {
      ...plugin(action), activate: () => ({ contributions: { messageActions: [action, action] } }),
    } })).rejects.toThrow("Duplicate contribution id");
    expect(registry.getMessageActions("local")).toEqual([]);
    await registry.dispose();
  });
});
