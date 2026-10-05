import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { machineSessionKey } from "../machineKeys";
import { SessionController } from "./sessionController";
import {
  defaultApi, deferred, EmitSocket, oldSession, status, transcriptSnapshotFixture, workspace,
  type AppState, type MessagePage, type SessionTranscriptSnapshot,
} from "./sessionController.testSupport";

const key = machineSessionKey("local", oldSession.id);
const oldTail = page("old branch", 200, 300);
const oldEarlier = page("old branch", 100, 300);
const newTail = page("new branch", 150, 250);

function fixture() {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
  const cache = new Map<string, MessagePage>();
  const transcripts = new ChatTranscriptStore({
    read: (id) => cache.get(id), write: (id, value) => { cache.set(id, value); }, remove: (id) => { cache.delete(id); },
  });
  const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
    .mockImplementationOnce(() => transcriptSnapshotFixture(oldTail, status(oldSession.id)))
    .mockImplementation(() => transcriptSnapshotFixture(newTail, status(oldSession.id), { seq: 2, partial: null }));
  const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve(oldEarlier));
  const socket = new EmitSocket();
  const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
    transcripts, socket,
    api: { ...defaultApi, transcriptSnapshot, messages, navigateTree: () => Promise.resolve({ cancelled: false }), thinkingLevels: () => Promise.resolve({ levels: [] }) },
  });
  function changeBranch(trigger: "observer" | "explicit") {
    if (trigger === "observer") {
      socket.emit({ type: "session.tree.changed", seq: 1 });
      return controller.refreshSelectedSession();
    }
    state = { ...state, treeDialog: { nodes: [{ id: "root", parentId: null, kind: "user", summary: "prompt" }], activeLeafId: "root", activePathIds: ["root"] } };
    return controller.navigateTree("root", { mode: "none" });
  }
  function expectNewBranch() {
    expect(state.selectedSession?.id).toBe(oldSession.id);
    expect(state.messagePageStart).toBe(150);
    expect(state.messagePageTotal).toBe(250);
    expect(transcripts.rawHistoryPage(key)).toEqual(newTail);
    expect(state.messages.every((message) => message.parts.some((part) => part.type === "text" && part.text.startsWith("new branch")))).toBe(true);
  }
  return { controller, cache, transcriptSnapshot, messages, changeBranch, expectNewBranch, state: () => state };
}

describe("SessionController branch read ownership", () => {
  it.each(["observer", "explicit"] as const)("retires an earlier-page response across %s tree changes without changing selection", async (trigger) => {
    const f = fixture();
    const earlier = deferred<MessagePage>();
    f.messages.mockReturnValueOnce(earlier.promise);
    try {
      await f.controller.selectSession(oldSession, { updateUrl: false });
      const loading = f.controller.loadEarlierMessages();
      await vi.waitFor(() => { expect(f.messages).toHaveBeenCalledOnce(); });
      await f.changeBranch(trigger);
      f.expectNewBranch();
      earlier.resolve(oldEarlier);
      await loading;
      expect(f.state().isLoadingEarlierMessages).toBe(false);
      f.expectNewBranch();
      await f.controller.refreshSelectedSession();
      f.expectNewBranch();
    } finally {
      earlier.resolve(oldEarlier);
      f.controller.dispose();
    }
  });

  it.each(["observer", "explicit"] as const)("retires an old snapshot rather than reseeding a discarded multi-page cache across %s tree changes", async (trigger) => {
    const f = fixture();
    const oldSnapshot = deferred<SessionTranscriptSnapshot>();
    try {
      await f.controller.selectSession(oldSession, { updateUrl: false });
      await f.controller.loadEarlierMessages();
      expect(f.state().messagePageStart).toBe(100);
      f.transcriptSnapshot.mockReturnValueOnce(oldSnapshot.promise);
      const polling = f.controller.refreshSelectedSession();
      await vi.waitFor(() => { expect(f.transcriptSnapshot).toHaveBeenCalledTimes(2); });
      const changing = f.changeBranch(trigger);
      // An explicit response invalidates immediately; socket invalidations are
      // buffered until the pending snapshot finishes and then retire its cache.
      if (trigger === "explicit") await vi.waitFor(() => { expect(f.cache.has(key)).toBe(false); });
      oldSnapshot.resolve({ page: oldTail, status: status(oldSession.id), seq: 0, partial: null });
      await Promise.all([polling, changing]);
      f.expectNewBranch();
      await f.controller.refreshSelectedSession();
      f.expectNewBranch();
    } finally {
      oldSnapshot.resolve({ page: oldTail, status: status(oldSession.id), seq: 0, partial: null });
      f.controller.dispose();
    }
  });
});

function page(branch: string, start: number, total: number): MessagePage {
  return { start, total, messages: Array.from({ length: 100 }, (_, index) => ({ role: "user", content: `${branch} ${String(start + index)}`, timestamp: start + index })) };
}
