const dispatchIdInput = element("dispatch-id", HTMLInputElement);
const dispatchOutput = element("dispatch-output", HTMLPreElement);
const declineReason = element("decline-reason", HTMLSelectElement);
const declineNote = element("decline-note", HTMLInputElement);
const declineKey = element("decline-key", HTMLInputElement);

function clearDispatchFields(): void {
  dispatchIdInput.value = "";
  declineNote.value = "";
  declineKey.value = "";
  render(dispatchOutput, "No dispatch loaded.");
}

element("pull-dispatch", HTMLButtonElement).addEventListener("click", () => {
  void busy("Pulling the next owner-authorized dispatch…", async () => {
    const result = await decodedResponse(await sameOriginFetch(
      "/api/v1/research/computer-agent-dispatches/pull",
      credentials(),
      { method: "POST", body: JSON.stringify({ transport: "WEB_INBOX" }) },
    ));
    const data = record(apiData(result), "Dispatch pull data");
    if (data.dispatch === null) {
      dispatchIdInput.value = "";
    } else {
      dispatchIdInput.value = text(record(data.dispatch, "Dispatch").dispatch_id, "dispatch_id");
      if (declineKey.value.trim() === "") {
        declineKey.value = `agent-decline:${dispatchIdInput.value.slice(0, 64)}`;
      }
    }
    render(dispatchOutput, result);
  });
});

element("decline-dispatch", HTMLButtonElement).addEventListener("click", () => {
  void busy("Declining the owner-authorized dispatch…", async () => {
    const dispatchId = dispatchIdInput.value.trim();
    const key = declineKey.value.trim();
    const reason = declineReason.value;
    const note = declineNote.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(dispatchId)) {
      throw new Error("Dispatch ID is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u.test(key)) {
      throw new Error("Decline idempotency key is invalid");
    }
    if (!["UNAVAILABLE", "UNSUPPORTED_TASK", "INSUFFICIENT_CONTEXT",
      "LOCAL_POLICY", "TRANSIENT_FAILURE", "OTHER"].includes(reason)) {
      throw new Error("Decline reason is invalid");
    }
    if (reason === "OTHER" && note === "") {
      throw new Error("OTHER decline requires a note");
    }
    const result = await decodedResponse(await sameOriginFetch(
      `/api/v1/research/computer-agent-dispatches/${encodeURIComponent(dispatchId)}/decline`,
      accessIdentity(),
      {
        method: "POST",
        idempotencyKey: key,
        body: JSON.stringify({ reason, ...(note === "" ? {} : { note }) }),
      },
    ));
    render(dispatchOutput, result);
    render(eventOutput, {
      message: "Dispatch declined. No workflow or task was transferred.",
      decline: apiData(result),
    });
  });
});

element("accept-dispatch", HTMLButtonElement).addEventListener("click", () => {
  void busy("Accepting the owner-authorized dispatch…", async () => {
    const dispatchId = dispatchIdInput.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(dispatchId)) {
      throw new Error("Dispatch ID is invalid");
    }
    const result = await decodedResponse(await sameOriginFetch(
      `/api/v1/research/computer-agent-dispatches/${encodeURIComponent(dispatchId)}/accept`,
      credentials(),
      { method: "POST", body: "{}" },
    ));
    const data = record(apiData(result), "Dispatch acceptance data");
    const workflowId = text(data.workflow_instance_id, "workflow_instance_id");
    workflowIdInput.value = workflowId;
    if (recoveryKey.value.trim() === "") {
      recoveryKey.value = `agent-recover-${workflowId.slice(0, 24)}`;
    }
    render(dispatchOutput, result);
    render(eventOutput, {
      message: "Dispatch accepted. Pull a task when the workflow reaches ANALYZE_BRANCHES.",
      acceptance: data,
    });
  });
});

clearDispatchFields();
