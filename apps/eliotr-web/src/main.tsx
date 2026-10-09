import React from "react";
import { createRoot } from "react-dom/client";
import { Bootstrap } from "./bootstrap";

const container = document.getElementById("root");
if (!container) throw new Error("Owner workspace root is missing.");

createRoot(container).render(
  <React.StrictMode>
    <Bootstrap />
  </React.StrictMode>,
);
