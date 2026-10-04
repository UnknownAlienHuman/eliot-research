const THEME_KEY = "eliotr.reading-theme.v1";
type ReadingTheme = "dark" | "light";

/** This preference contains no source, session or research information. */
export function mountWorkspaceTheme(root: HTMLElement): () => void {
  let theme: ReadingTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") theme = saved;
  } catch { /* Storage is optional. */ }
  const button = root.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  const menu = root.querySelector<HTMLDetailsElement>(".workspace-menu");
  const apply = (): void => {
    document.documentElement.dataset.theme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#17191b" : "#f6f7f8");
    if (button) {
      button.textContent = theme === "dark" ? "Light theme" : "Dark theme";
      button.setAttribute("aria-label", theme === "dark" ? "Use light theme" : "Use dark theme");
      button.setAttribute("aria-pressed", String(theme === "light"));
    }
  };
  const toggle = (): void => {
    theme = theme === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* The current choice still works. */ }
    apply();
  };
  const closeMenu = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest("a")) { if (menu) menu.open = false; }
  };
  const escapeMenu = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && menu?.open) {
      event.preventDefault(); menu.open = false; menu.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    }
  };
  apply(); button?.addEventListener("click", toggle);
  menu?.addEventListener("click", closeMenu); menu?.addEventListener("keydown", escapeMenu);
  return () => { button?.removeEventListener("click", toggle); menu?.removeEventListener("click", closeMenu); menu?.removeEventListener("keydown", escapeMenu); };
}
