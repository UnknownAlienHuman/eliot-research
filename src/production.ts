// Keep the existing eliotr-core Durable Object export identity. Before cutover,
// verify its ResearchSession namespace has no stored objects. Never rename/delete it.
export { default, IngestWorkflow, DistillWorkflow, OcrWorkflow } from "./index";
export { ChatAgent as ResearchSession } from "./chat";
