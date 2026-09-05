type Theme = "light" | "dark";

export default function ThemeSwitch({
  theme,
  onToggle,
}: {
  theme: Theme;
  onToggle: () => void;
}) {
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <button
      className="theme-switch"
      type="button"
      role="switch"
      aria-checked={theme === "dark"}
      aria-label={`Theme is ${theme}. Switch to ${nextTheme} mode`}
      data-theme={theme}
      onClick={onToggle}
    >
      <span className={theme === "light" ? "active" : ""}>Light</span>
      <span className={theme === "dark" ? "active" : ""}>Dark</span>
    </button>
  );
}
