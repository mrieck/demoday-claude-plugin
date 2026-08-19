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

/**
 * Type sizes in the template were tuned against a 1080px short side. This factor
 * keeps them honest at other resolutions: exactly 1 for both 1920x1080 and
 * 1080x1920 (so existing landscape renders are pixel-identical), smaller for the
 * low-res selftest fixtures.
 */
export const typeScale = (width, height) => Math.min(width, height) / 1080;

export function themeFrom(brand = {}) {
  return {
    ...defaultTheme,
    ...(brand.colors || {}),
    font: brand.font ? `${brand.font}, ${defaultTheme.font}` : defaultTheme.font,
  };
}
