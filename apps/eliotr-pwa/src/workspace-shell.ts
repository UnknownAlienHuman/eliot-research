interface WorkspaceShellCopy {
  readonly healthBadge: string;
  readonly healthSummary: string;
  readonly healthDetails: string;
  readonly workspaceConnection: string;
}

const icon = (paths: string): string => `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Presentation only. The composition root owns all controllers and private state. */
export function renderWorkspaceShell(copy: WorkspaceShellCopy): string {
  return `
    <a class="skip-link" href="#workspace-content">Skip to content</a>
    <header class="topbar">
      <a class="brand" href="/" aria-label="Eliot Research home"><span class="brand-mark">E</span><span>Eliot Research</span></a>
      <div class="topbar-meta"><span class="workspace-label">Private workspace</span><span id="health-badge">${copy.healthBadge}</span></div>
    </header>
    <div class="health-strip" role="status" aria-live="polite">
      <span class="health-dot" aria-hidden="true"></span><span id="health-summary">${copy.healthSummary}</span>
      <button class="button button--quiet" type="button" data-refresh>Retry connection</button>
      <a class="health-help" href="#connections-card">Connection details</a>
    </div>
    <main class="workspace" aria-label="Research workspace">
      <aside class="panel panel--corpus" aria-label="Research navigation">
        <nav class="workspace-nav" aria-label="Primary">
          <button class="nav-item nav-item--active" type="button" data-nav-target="#library" aria-controls="sources-view" aria-current="page">${icon('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h4M10 12h5M10 16h5"/>')}<span>Documents</span></button>
          <button class="nav-item" type="button" data-nav-target="#research-card" aria-controls="research-view">${icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5M10.5 7v7M7 10.5h7"/>')}<span>Research</span></button>
          <button class="nav-item" type="button" data-nav-target="#wiki-card" aria-controls="wiki-view">${icon('<path d="M12 5v15M3 4h5a4 4 0 0 1 4 3 4 4 0 0 1 4-3h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3z"/>')}<span>Wiki</span></button>
          <button class="nav-item" type="button" data-nav-target="#connections-card" aria-controls="connections-card">${icon('<path d="m9 15 6-6M7.5 14.5l-2 2a3.5 3.5 0 0 0 5 5l3-3a3.5 3.5 0 0 0 0-5M16.5 9.5l2-2a3.5 3.5 0 0 0-5-5l-3 3a3.5 3.5 0 0 0 0 5"/>')}<span>Connections</span></button>
        </nav>
        <button class="source-chooser-toggle" type="button" data-source-chooser-toggle aria-controls="library" aria-expanded="false"><span>Choose a document</span><span data-source-chooser-state>Show list</span></button>
        <div id="library"></div>
      </aside>
      <section id="workspace-content" class="panel panel--investigation" aria-label="Investigation workspace" tabindex="-1">
        <div class="content-heading"><div><h1 data-workspace-title>Documents</h1><p class="lede" data-workspace-lede>Choose a document to read, or add a source to your library.</p></div></div>
        <section id="sources-view" class="workspace-view" data-workspace-view="sources" tabindex="-1" aria-label="Documents">
          <div class="tool-stack">
            <section class="tool-card reader-card" id="corpus-lens-card"><div id="corpus-lens"></div></section>
            <details class="tool-card tool-card--import" id="source-import-card"><summary>Add documents</summary><div id="source-namespace"></div><div class="tool-divider"></div><div id="raw-upload"></div><div class="tool-divider"></div><div id="bundle-import"></div></details>
            <details class="tool-card" id="projects-card"><summary>Organize projects</summary><div id="projects"></div></details>
            <details class="tool-card"><summary>Delete selected document</summary><div id="erasure"></div></details>
          </div>
        </section>
        <section id="research-view" class="workspace-view" data-workspace-view="research" tabindex="-1" aria-label="Research" hidden>
          <div class="tool-stack">
            <section class="tool-card tool-card--research" id="research-card"><div id="research-run"></div></section>
            <div class="research-context" aria-label="Search evidence status"><div><span>Search coverage</span><strong id="coverage">Not queried</strong><span id="coverage-note">Run a search to measure sampled resolution.</span></div><div><span>Evidence</span><strong id="evidence-count">0 resolved</strong><span>Verified excerpts in this session.</span></div></div>
            <details class="tool-card research-tools" id="research-tools"><summary>Search and full-source scans</summary><div id="retrieval"></div><div class="tool-divider"></div><div id="exhaustive-workflow"></div></details>
            <details class="tool-card" id="research-changes-card"><summary>Recent activity</summary><div id="research-changes"></div></details>
          </div>
        </section>
        <section id="wiki-view" class="workspace-view" data-workspace-view="wiki" tabindex="-1" aria-label="Wiki" hidden>
          <div class="tool-stack"><section class="tool-card" id="wiki-card"><div id="wiki"></div></section></div>
        </section>
        <section id="connections-card" class="workspace-view" data-workspace-view="connections" tabindex="-1" aria-label="Connections" hidden>
          <div class="connection-stack">
            <section class="connection-card research-configuration-card" id="research-configuration-card"><div id="research-configuration"></div></section>
            <article class="connection-card" id="connection-server-card">
              <div class="connection-heading"><h2>Workspace connection</h2><span id="connection-server-state" class="connection-state connection-state--pending">Checking</span></div>
              <p id="connection-server-copy" class="connection-copy">Checking API and schema readiness.</p>
              <details class="connection-details"><summary>Diagnostics</summary><dl class="connection-facts"><dt>Deployment</dt><dd id="connection-deployment">Not checked</dd><dt>Core schema</dt><dd id="connection-core-generation">Unknown</dd><dt>Search schema</dt><dd id="connection-search-generation">Unknown</dd></dl><div id="connection-health-details" class="health-details-content">${copy.healthDetails}</div></details>
              <div class="connection-actions"><button class="button button--quiet" type="button" data-connection-refresh>Retry server check</button></div>
            </article>
            <article class="connection-card" id="connection-workspace-card">
              <div class="connection-heading"><h2>Google Drive</h2><span id="connection-transport-state" class="connection-state connection-state--unknown">Unknown</span></div>
              <p id="connection-transport-copy" class="connection-copy">${copy.workspaceConnection}</p>
              <div id="google-oauth"></div><div id="owner-session"></div>
            </article>
            <details class="connection-card" id="client-grants-card"><summary>Agent access</summary><div id="client-grants"></div></details>
            <details class="connection-card" id="connection-agent-card"><summary>Client connection check</summary><div id="mcp-client-diagnostic"></div></details>
          </div>
          <details class="access-boundary"><summary>Access and privacy</summary><p>Reads resolve through the owner API. Private data is never cached in the browser.</p></details>
        </section>
      </section>
      <aside class="panel panel--evidence" aria-label="Evidence details">
        <div class="evidence-heading"><div><h2>Source excerpt</h2><span class="rail-status">No excerpt selected</span></div><button class="button button--quiet" type="button" data-close-evidence aria-label="Close source excerpt">Close</button></div>
        <div id="evidence-empty" class="evidence-empty"><strong>Select an excerpt</strong><p>The source text and verification details will appear here.</p></div>
        <article id="evidence-detail" class="evidence-detail" hidden></article>
      </aside>
    </main>`;
}
