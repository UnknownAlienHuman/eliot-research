import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Dialog, Field, IconButton, Status } from "../src/primitives/primitives";
import "../src/theme.css";

function Qualification() {
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(true);
  return (
    <main className="eliot-token-story" lang="en">
      <h1>Native Material controls</h1>
      <Field id="qualification-question" label="Research question" hint="Use your selected sources" defaultValue="What makes evidence useful?" />
      <Button onClick={() => { setShow(true); setOpen(true); }}>Review source</Button>
      <IconButton label="Open source details" icon="evidence" onClick={() => setOpen(true)} />
      <Status icon="file">Source readiness unknown</Status>
      {show && <Dialog open={open} title="Review source" onClose={() => setOpen(false)}>
        <p>Read the exact source context, then return to your question.</p>
        <Button variant="tonal" onClick={() => setOpen(false)}>Back to research</Button>
        <Button variant="text" onClick={() => setShow(false)}>Leave review</Button>
      </Dialog>}
    </main>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Qualification root missing");
createRoot(container).render(<React.StrictMode><Qualification /></React.StrictMode>);
