const dispatchIdInput = element("dispatch-id", HTMLInputElement);
const dispatchOutput = element("dispatch-output", HTMLPreElement);

function clearDispatchFields(): void {
  dispatchIdInput.value = "";
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
    }
    render(dispatchOutput, result);
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
