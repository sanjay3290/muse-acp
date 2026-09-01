/**
 * Multi-stage shell approvals (tdd SS5.4).
 *
 * A compound shell command produces one approval with N stages. Muse asks for
 * stage 1 with `approval/requested`, then advances every later stage with
 * `approval/updated` only — it never re-issues a request. A client that drives
 * its handler from `approval/requested` alone decides stage 1 and then waits
 * forever, and the turn never completes.
 */

import { describe, it, expect } from "vitest";
import { ApprovalRouter } from "../vendor/muse-sdk/src/facade/approval.js";
import type { ApprovalRequestParams, ApprovalUpdatedParams } from "../vendor/msp-ts/msp.d.ts";

const SESSION = "sess-1";
const APPROVAL = "appr-1";

function choices(label: string) {
  return [
    { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
    { choiceId: "abort", decision: "abort", label: "Reject", scope: "once", acceptsFeedback: true },
  ].map((c) => ({ ...c, rulePreview: label })) as ApprovalRequestParams["availableChoices"];
}

function requested(): ApprovalRequestParams {
  return {
    approvalId: APPROVAL,
    availableChoices: choices("wc ..."),
    currentRequirementId: { approvalId: APPROVAL, sourceIndex: 0 },
    itemId: "item-1",
    judgeEscalated: false,
    protectedWrite: false,
    rawArgs: '{"command":"wc -c a.txt; echo x"}',
    sessionId: SESSION,
    sourceRange: {} as ApprovalRequestParams["sourceRange"],
    subject: { kind: "shell" } as ApprovalRequestParams["subject"],
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "bash",
    turnId: "turn-1",
    viewCursor: "v:1",
  };
}

function updatedToStage(sourceIndex: number): ApprovalUpdatedParams {
  return {
    approvalId: APPROVAL,
    availableChoices: choices("echo ..."),
    change: {
      kind: "stageResolved",
      choiceId: "allow_once",
      decision: "approved",
      requirementId: { approvalId: APPROVAL, sourceIndex: sourceIndex - 1 },
    },
    currentRequirementId: { approvalId: APPROVAL, sourceIndex },
    sessionId: SESSION,
    sourceRange: {} as ApprovalUpdatedParams["sourceRange"],
    subject: { kind: "shell" } as ApprovalUpdatedParams["subject"],
    viewCursor: `v:${sourceIndex + 1}`,
  };
}

function fakeConnection() {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    sent,
    connection: {
      command: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        return {};
      },
    } as never,
  };
}

describe("ApprovalRouter multi-stage", () => {
  it("decides a stage advanced by approval/updated", async () => {
    const { sent, connection } = fakeConnection();
    const router = new ApprovalRouter(SESSION, connection);
    const seen: number[] = [];
    router.onApproval((req) => {
      seen.push(req.currentRequirementId.sourceIndex);
      return { choiceId: "allow_once" };
    });

    await router.requested(requested());
    await router.updated(updatedToStage(1));
    await router.updated(updatedToStage(2));

    expect(seen).toEqual([0, 1, 2]);
    expect(sent.map((s) => (s.params.requirementId as { sourceIndex: number }).sourceIndex)).toEqual([0, 1, 2]);
    expect(sent.every((s) => s.method === "approval/decide")).toBe(true);
  });

  it("does not re-decide a stage already decided", async () => {
    const { sent, connection } = fakeConnection();
    const router = new ApprovalRouter(SESSION, connection);
    router.onApproval(() => ({ choiceId: "allow_once" }));

    await router.requested(requested());
    // Single-stage approval: the update echoes the stage just decided.
    await router.updated({
      ...updatedToStage(1),
      currentRequirementId: { approvalId: APPROVAL, sourceIndex: 0 },
    });

    expect(sent).toHaveLength(1);
  });

  it("carries the updated stage's choices and subject into the handler", async () => {
    const { connection } = fakeConnection();
    const router = new ApprovalRouter(SESSION, connection);
    let stage1: ApprovalRequestParams | undefined;
    router.onApproval((req) => {
      stage1 = req as ApprovalRequestParams;
      return { choiceId: "allow_once" };
    });

    await router.requested(requested());
    const update = updatedToStage(1);
    await router.updated(update);

    expect(stage1?.availableChoices).toBe(update.availableChoices);
    expect(stage1?.subject).toBe(update.subject);
    // Request-shape members the update does not carry come from the original.
    expect(stage1?.toolName).toBe("bash");
    expect(stage1?.turnId).toBe("turn-1");
  });

  it("ignores an update for an approval it never saw requested", async () => {
    const { sent, connection } = fakeConnection();
    const router = new ApprovalRouter(SESSION, connection);
    router.onApproval(() => ({ choiceId: "allow_once" }));
    await router.updated(updatedToStage(1));
    expect(sent).toHaveLength(0);
  });

  it("stops advancing once the approval resolves", async () => {
    const { sent, connection } = fakeConnection();
    const router = new ApprovalRouter(SESSION, connection);
    router.onApproval(() => ({ choiceId: "allow_once" }));
    await router.requested(requested());
    router.resolved(APPROVAL);
    await router.updated(updatedToStage(1));
    expect(sent).toHaveLength(1);
  });
});
