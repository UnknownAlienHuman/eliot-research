import { useRef, useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { WorkspaceLink } from "../routes/WorkspaceLink";
import type { playResearchJourney } from "./ResearchPreview";

const destinations = [
  { to: "/sources", label: "Sources" },
  { to: "/research", label: "Research" },
  { to: "/studio", label: "Studio" },
  { to: "/connections", label: "Connections" },
] as const;

function WorkspaceLinkFixture() {
  const location = useLocation();
  const navigate = useNavigate();
  const researchAnchor = useRef<HTMLAnchorElement>(null);
  const [preventedClicks, setPreventedClicks] = useState(0);

  return (
    <section aria-label="Workspace link fixture">
      <h2>Workspace link navigation</h2>
      <nav aria-label="Fixture workspace destinations">
        {destinations.map(destination => (
          <WorkspaceLink
            key={destination.to}
            to={destination.to}
            title={`Go to ${destination.label}`}
            {...(destination.to === "/research" ? { ref: researchAnchor } : {})}
          >
            {destination.label}
          </WorkspaceLink>
        ))}
      </nav>
      <p><output aria-label="Current workspace path">{location.pathname}</output></p>
      <button type="button" onClick={() => navigate(-1)}>Back in workspace history</button>
      <button type="button" onClick={() => researchAnchor.current?.focus()}>
        Focus Research through its ref
      </button>
      <p>
        <WorkspaceLink to="/sources" onClick={event => {
          event.preventDefault();
          setPreventedClicks(count => count + 1);
        }}>
          Prevent Sources navigation
        </WorkspaceLink>
      </p>
      <output aria-label="Caller-prevented click count">{preventedClicks}</output>
      <p>
        <WorkspaceLink to="/studio" target="_blank" rel="noopener noreferrer">
          Studio in a new tab
        </WorkspaceLink>
      </p>
      <p>
        <WorkspaceLink to="/connections" target="_self">Connections in this tab</WorkspaceLink>
      </p>
    </section>
  );
}

/** Root registers this fixture in its existing Shell.stories.tsx. */
export function WorkspaceLinkPreview() {
  return <MemoryRouter initialEntries={["/research"]}><WorkspaceLinkFixture /></MemoryRouter>;
}

function requireAnchor(element: HTMLElement): HTMLAnchorElement {
  if (!(element instanceof HTMLAnchorElement)) throw new Error("The workspace link must be a native anchor.");
  return element;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Observe the component's result before canceling any remaining native navigation. */
function dispatchAndObserve(
  anchor: HTMLAnchorElement,
  type: "click" | "auxclick" = "click",
  init: MouseEventInit = {},
) {
  const ownerDocument = anchor.ownerDocument;
  const event = new MouseEvent(type, {
    button: 0, ...init, bubbles: true, cancelable: true, composed: true,
  });
  let observations = 0;
  let defaultPreventedBeforeSuppression = false;
  const suppressRemainingDefault = (observed: Event) => {
    if (observed !== event) return;
    observations += 1;
    defaultPreventedBeforeSuppression = observed.defaultPrevented;
    observed.preventDefault();
  };
  ownerDocument.addEventListener(type, suppressRemainingDefault);
  try {
    const dispatchResult = anchor.dispatchEvent(event);
    assert(observations === 1, "The dispatched event must reach the document observer exactly once.");
    assert(dispatchResult === false, "dispatchEvent must report cancellation after the safety guard.");
    assert(event.defaultPrevented, "No remaining native navigation may escape the safety guard.");
    return { defaultPreventedBeforeSuppression };
  } finally {
    ownerDocument.removeEventListener(type, suppressRemainingDefault);
  }
}

function nextFrame(ownerDocument: Document) {
  const frameWindow = ownerDocument.defaultView;
  if (!frameWindow) throw new Error("The fixture document has no rendering window.");
  return new Promise<void>(resolve => { frameWindow.requestAnimationFrame(() => resolve()); });
}

/** Bounded native commit wait, following the app previews' assertion convention. */
async function waitForAssertion(ownerDocument: Document, check: () => void) {
  let lastFailure: unknown;
  for (let frame = 0; frame < 60; frame += 1) {
    try { check(); return; } catch (error) { lastFailure = error; }
    await nextFrame(ownerDocument);
  }
  if (lastFailure instanceof Error) throw lastFailure;
  throw new Error("The expected workspace state did not commit within 60 rendering frames.");
}

/** Let route commits become observable before checking a non-navigation case. */
async function settleRouteFrames(ownerDocument: Document) {
  await nextFrame(ownerDocument);
  await nextFrame(ownerDocument);
}

export async function playWorkspaceLinkJourney({ canvas }: Parameters<typeof playResearchJourney>[0]) {
  const navigation = canvas.getByRole("navigation", { name: "Fixture workspace destinations" });
  const ownerDocument = navigation.ownerDocument;
  const currentPath = canvas.getByRole("status", { name: "Current workspace path" });
  const anchor = (label: string) => requireAnchor(canvas.getByRole("link", { name: label, exact: true }));

  async function assertRoute(expected: string) {
    await waitForAssertion(ownerDocument, () => {
      assert(currentPath.textContent === expected, `The router must commit ${expected}.`);
      for (const destination of destinations) {
        const link = anchor(destination.label);
        assert(navigation.contains(link), `${destination.label} must belong to the workspace navigation.`);
        assert(link.getAttribute("aria-current") === (destination.to === expected ? "page" : null),
          `Only the current ${expected} destination may have aria-current=page.`);
      }
    });
  }

  async function navigateWithLink(label: string, expected: string) {
    const observed = dispatchAndObserve(anchor(label));
    assert(observed.defaultPreventedBeforeSuppression, `${label}: ordinary local navigation must cancel native default before the guard.`);
    await assertRoute(expected);
  }

  async function backTo(expected: string) {
    canvas.getByRole("button", { name: "Back in workspace history" }).click();
    await assertRoute(expected);
  }

  // Native anchors expose the four exact public paths and retain caller anchor attributes.
  for (const destination of destinations) {
    const link = anchor(destination.label);
    assert(navigation.contains(link), `${destination.label} must be a native link inside navigation.`);
    assert(link.getAttribute("href") === destination.to, `${destination.label} must expose its exact absolute workspace href.`);
    assert(new URL(link.href).pathname === destination.to, `${destination.label} must resolve to its public workspace path.`);
    assert(new URL(link.href).origin === new URL(ownerDocument.baseURI).origin, `${destination.label} must remain same-origin.`);
    assert(link.getAttribute("title") === `Go to ${destination.label}`, `${destination.label} must retain its caller-supplied title.`);
  }
  await assertRoute("/research");

  // The React 19 ref reaches the actual rendered anchor, proven through native focus identity.
  canvas.getByRole("button", { name: "Focus Research through its ref" }).click();
  assert(ownerDocument.activeElement === anchor("Research"), "The forwarded ref must focus the actual rendered Research anchor.");

  // Ordinary link navigation and actual router Back update the active destination both ways.
  await navigateWithLink("Sources", "/sources");
  await navigateWithLink("Research", "/research");
  await backTo("/sources");
  await backTo("/research");
  await navigateWithLink("Studio", "/studio");
  await backTo("/research");
  await navigateWithLink("Connections", "/connections");
  await backTo("/research");

  // Caller cancellation runs once, remains canceled before the safety guard, and blocks routing.
  const callerPrevented = dispatchAndObserve(anchor("Prevent Sources navigation"));
  assert(callerPrevented.defaultPreventedBeforeSuppression, "Caller cancellation must precede the safety guard.");
  await waitForAssertion(ownerDocument, () => {
    assert(canvas.getByRole("status", { name: "Caller-prevented click count" }).textContent === "1",
      "The caller's prevented onClick must run exactly once.");
  });
  await settleRouteFrames(ownerDocument);
  await assertRoute("/research");

  // Native modifier and middle-button behavior remains available; the safety guard prevents opens.
  const nativeCases: readonly { readonly name: string; readonly type: "click" | "auxclick"; readonly init: MouseEventInit }[] = [
    { name: "Control", type: "click", init: { ctrlKey: true } },
    { name: "Meta", type: "click", init: { metaKey: true } },
    { name: "Shift", type: "click", init: { shiftKey: true } },
    { name: "Alt", type: "click", init: { altKey: true } },
    { name: "Middle click", type: "click", init: { button: 1 } },
    { name: "Middle auxiliary click", type: "auxclick", init: { button: 1 } },
  ];
  for (const nativeCase of nativeCases) {
    const observed = dispatchAndObserve(anchor("Studio"), nativeCase.type, nativeCase.init);
    assert(observed.defaultPreventedBeforeSuppression === false, `${nativeCase.name} must retain native anchor handling before suppression.`);
    await settleRouteFrames(ownerDocument);
    await assertRoute("/research");
  }

  // _blank is left to the native anchor, while _self uses the existing local router.
  const blank = anchor("Studio in a new tab");
  assert(blank.getAttribute("target") === "_blank", "The native new-tab target must be retained.");
  assert(blank.getAttribute("rel") === "noopener noreferrer", "The native new-tab rel must be retained.");
  assert(blank.getAttribute("href") === "/studio", "The new-tab link must expose the Studio href.");
  const blankClick = dispatchAndObserve(blank);
  assert(blankClick.defaultPreventedBeforeSuppression === false, "The new-tab click must remain native before suppression.");
  await settleRouteFrames(ownerDocument);
  await assertRoute("/research");

  const self = anchor("Connections in this tab");
  assert(self.getAttribute("target") === "_self", "The native same-tab target must be retained.");
  assert(self.getAttribute("href") === "/connections", "The same-tab link must expose the Connections href.");
  await navigateWithLink("Connections in this tab", "/connections");
  await backTo("/research");
}
