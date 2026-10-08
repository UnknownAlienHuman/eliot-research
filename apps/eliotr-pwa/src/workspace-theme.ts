const THEME_KEY = "eliotr.reading-theme.v1";
type ReadingTheme = "system" | "dark" | "light";

/** This preference contains no source, session or research information. */
export function mountWorkspaceTheme(root: HTMLElement): () => void {
  let theme: ReadingTheme = document.documentElement.dataset.theme === "light" || document.documentElement.dataset.theme === "dark"
    ? document.documentElement.dataset.theme
    : "system";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "system" || saved === "dark" || saved === "light") theme = saved;
  } catch { /* Storage is optional. */ }
  const select = root.querySelector<HTMLSelectElement>("[data-theme-select]");
  const menu = root.querySelector<HTMLDetailsElement>(".workspace-menu");
  const colorScheme = window.matchMedia("(prefers-color-scheme: light)");
  const resolvedTheme = (): "dark" | "light" => theme === "system" ? (colorScheme.matches ? "light" : "dark") : theme;
  const apply = (): void => {
    document.documentElement.dataset.theme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", resolvedTheme() === "dark" ? "#17191b" : "#f6f7f8");
    if (select && select.value !== theme) select.value = theme;
  };
  const changeTheme = (): void => {
    const value = select?.value;
    if (value !== "system" && value !== "dark" && value !== "light") return;
    theme = value;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* The current choice still works. */ }
    apply();
  };
  const followSystemTheme = (): void => { if (theme === "system") apply(); };
  const closeMenu = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest("a")) { if (menu) menu.open = false; }
  };
  const escapeMenu = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && menu?.open) {
      event.preventDefault(); menu.open = false; menu.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    }
  };
  apply(); select?.addEventListener("change", changeTheme);
  colorScheme.addEventListener("change", followSystemTheme);
  menu?.addEventListener("click", closeMenu); menu?.addEventListener("keydown", escapeMenu);
  return () => { select?.removeEventListener("change", changeTheme); colorScheme.removeEventListener("change", followSystemTheme); menu?.removeEventListener("click", closeMenu); menu?.removeEventListener("keydown", escapeMenu); };
}
