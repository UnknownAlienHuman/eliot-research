interface WorkspaceShellCopy {
  readonly healthBadge: string;
  readonly healthSummary: string;
  readonly healthDetails: string;
  readonly workspaceConnection: string;
}

/** Presentation only. The composition root owns all controllers and private state. */
export function renderWorkspaceShell(copy: WorkspaceShellCopy): string {
  return `
    <a class="skip-link" href="#workspace-content">Skip to content</a>
    <header class="topbar">
      <a class="brand" href="/" aria-label="Eliot Research home"><span class="brand-mark">E</span><span>Eliot Research</span></a>
      <button class="button button--quiet reading-back" type="button" data-reading-back hidden>Back</button>
      <nav class="workspace-nav" aria-label="Primary">
        <button class="nav-item nav-item--active" type="button" data-nav-target="#library" aria-controls="sources-view" aria-current="page">Sources</button>
        <button class="nav-item" type="button" data-nav-target="#research-card" aria-controls="research-view">Research</button>
        <button class="nav-item" type="button" data-nav-target="#wiki-card" aria-controls="wiki-view">Wiki</button>
        <button class="nav-item" type="button" data-nav-target="#connections-card" aria-controls="connections-card">Connections</button>
      </nav>
      <div class="topbar-actions">
        <button class="button button--quiet source-chooser-toggle" type="button" data-source-chooser-toggle aria-controls="library" aria-expanded="false"><span data-source-chooser-label>Sources</span></button>
        <details class="workspace-menu"><summary aria-label="Workspace menu">Menu</summary><div class="workspace-menu-content"><label class="theme-choice">Appearance<select data-theme-select aria-label="Color theme"><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label><a href="#library">Sources</a><a href="#research-card">Research</a><a href="#wiki-card">Wiki</a><a href="#connections-card">Connections</a></div></details>
      </div>
    </header>
    <div class="health-strip" role="status" aria-live="polite">
      <span id="health-badge">${copy.healthBadge}</span><span id="health-summary">${copy.healthSummary}</span>
      <button class="button button--quiet" type="button" data-refresh>Retry connection</button>
      <a class="health-help" href="#connections-card">Connection details</a>
    </div>
    <main class="workspace" aria-label="Research workspace">
      <aside class="panel panel--sources" aria-labelledby="sources-column-title">
        <div class="column-heading"><h2 id="sources-column-title">Sources</h2><span>Workspace library</span><button class="button button--quiet pane-toggle" type="button" data-sources-pane-toggle aria-controls="library-sidebar-home" aria-expanded="true" aria-label="Hide Sources panel" title="Hide Sources panel"><span data-pane-toggle-label>Hide</span></button></div>
        <div id="library-sidebar-home"></div>
      </aside>
      <section id="workspace-content" class="panel panel--investigation" aria-label="Investigation workspace" tabindex="-1">
        <div class="content-heading"><div><h1 data-workspace-title>Sources</h1><p class="lede" data-workspace-lede>Choose a document to read, or add a source to your library.</p></div></div>
        <section id="sources-view" class="workspace-view" data-workspace-view="sources" tabindex="-1" aria-label="Documents">
          <div id="document-list-home"></div>
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
            <details class="tool-card research-tools" id="research-tools"><summary>Search and full-source scans</summary><div class="research-context" aria-label="Search evidence status"><div><span>Search coverage</span><strong id="coverage">Not queried</strong><span id="coverage-note">Run a search to measure sampled resolution.</span></div><div><span>Evidence</span><strong id="evidence-count">0 resolved</strong><span>Verified excerpts in this session.</span></div></div><div id="retrieval"></div><div class="tool-divider"></div><div id="exhaustive-workflow"></div></details>
            <div id="research-changes-card"><div id="research-changes"></div></div>
          </div>
        </section>
        <section id="wiki-view" class="workspace-view" data-workspace-view="wiki" tabindex="-1" aria-label="Wiki" hidden>
          <div class="tool-stack"><section class="tool-card" id="wiki-card"><div id="wiki"></div></section></div>
        </section>
        <section id="connections-card" class="workspace-view" data-workspace-view="connections" tabindex="-1" aria-label="Connections" hidden>
          <div class="connection-stack">
            <section class="connection-card research-configuration-card" id="research-configuration-card"><div id="research-configuration"></div></section>
            <article class="connection-card" id="research-provider-key-card"><div id="research-provider-key"></div><div id="research-provider-key-model-use"></div></article>
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
      <aside class="panel panel--inspector" aria-labelledby="inspector-column-title">
        <div class="column-heading"><h2 id="inspector-column-title">Context inspector</h2><span>Evidence and revisions</span><button class="button button--quiet pane-toggle" type="button" data-inspector-pane-toggle aria-controls="inspector-column-content" aria-expanded="true" aria-label="Hide context panel" title="Hide context panel"><span data-pane-toggle-label>Hide</span></button></div>
        <div id="inspector-column-content" data-inspector-body>
          <p data-inspector-default>Open a report in Research, then select a citation to inspect its evidence and source revision.</p>
          <p data-inspector-report hidden>A report is open in Research. Select a citation to inspect its evidence and source revision.</p>
        </div>
      </aside>
      <dialog class="panel panel--corpus library-drawer" aria-labelledby="library-drawer-title">
        <div class="drawer-heading"><h2 id="library-drawer-title">Sources</h2><button class="button button--quiet" type="button" data-close-library autofocus>Close</button></div>
        <div id="library"></div>
      </dialog>
      <dialog class="panel panel--evidence" aria-labelledby="evidence-drawer-title">
        <div class="evidence-heading"><div><h2 id="evidence-drawer-title">Source excerpt</h2><span class="rail-status" role="status" aria-live="polite">No excerpt selected</span></div><button class="button button--quiet" type="button" data-close-evidence aria-label="Close source excerpt" autofocus>Close</button></div>
        <div id="evidence-empty" class="evidence-empty"><strong>Select an excerpt</strong><p>The source text and verification details will appear here.</p></div>
        <article id="evidence-detail" class="evidence-detail" hidden></article>
      </dialog>
    </main>`;
}
