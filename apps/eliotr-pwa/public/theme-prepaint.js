/* global localStorage, document */
try {
  const saved = localStorage.getItem("eliotr.reading-theme.v1");
  if (saved === "dark" || saved === "light") {
    document.documentElement.dataset.theme = saved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", saved === "dark" ? "#17191b" : "#f6f7f8");
  }
} catch {
  // The default theme is available when browser storage is disabled.
}
