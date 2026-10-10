import { configureContractsForStrictCsp } from "@eliotr/owner-api-client/runtime-config";
import "./app/style.css";

function showStartupFailure(): void {
  const container = document.getElementById("root");
  if (container) {
    container.hidden = true;
    container.inert = true;
    container.setAttribute("aria-hidden", "true");
  }
  const guard = document.getElementById("privacy-guard");
  if (!guard) return;
  const message = document.createElement("p");
  message.textContent = "The workspace could not start. Reload to try again.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "er-button er-button--tonal";
  retry.textContent = "Reload workspace";
  retry.addEventListener("click", () => window.location.reload());
  guard.replaceChildren(message, retry);
  guard.hidden = false;
  retry.focus();
}

try {
  configureContractsForStrictCsp();
  void import("./app/bootstrap").catch(showStartupFailure);
} catch {
  showStartupFailure();
}
