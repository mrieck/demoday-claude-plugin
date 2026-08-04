/**
 * Brand tokens, filled in from demo.json's `brand` block at render time.
 * Defaults are deliberately neutral so an unbranded first render still looks
 * deliberate rather than unfinished.
 */
export const defaultTheme = {
  primary: "#5B8DEF",
  bg: "#0B0D12",
  text: "#FFFFFF",
  muted: "#8A94A8",
  font: "Inter, -apple-system, system-ui, sans-serif",
};

export function themeFrom(brand = {}) {
  return {
    ...defaultTheme,
    ...(brand.colors || {}),
    font: brand.font ? `${brand.font}, ${defaultTheme.font}` : defaultTheme.font,
  };
}
