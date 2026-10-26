import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./ui/tokens/fonts/fonts.css";
import "./ui/tokens/theme.css";
import "./ui/primitives.css";
import "./ui/controls.css";
import "./shell.css";
import "./library.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing.");
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(root).render(<StrictMode><QueryClientProvider client={client}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></StrictMode>);
