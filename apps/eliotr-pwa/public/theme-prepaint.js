/* global localStorage, document, window */
let theme = "system";
try {
  const saved = localStorage.getItem("eliotr.reading-theme.v1");
  if (saved === "dark" || saved === "light" || saved === "system") theme = saved;
} catch { /* The system theme remains available when browser storage is disabled. */ }

document.documentElement.dataset.theme = theme;
const resolvedTheme = theme === "system"
  ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
  : theme;
document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolvedTheme === "dark" ? "#17191b" : "#f6f7f8");
