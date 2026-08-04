/**
 * The synthetic cursor injected into every page during a web recording.
 *
 * Why this exists: Playwright's real mouse is invisible to `recordVideo`. Without
 * a drawn cursor the footage shows menus opening and fields filling with no visible
 * cause, which reads as a glitch rather than a demo.
 *
 * Why the animation runs in the BROWSER rather than in Node: driving 60 fps of
 * motion over CDP means 60 round trips per move, and any hiccup shows up as a
 * stutter in the recording. Instead Node hands over the whole path once and the
 * page animates it with requestAnimationFrame. Node still issues a handful of real
 * `page.mouse.move` calls along the same path so genuine :hover states fire.
 *
 * Installed via page.addInitScript so it survives navigations.
 */

export const CURSOR_INIT_SCRIPT = `
(() => {
  if (window.__demodayCursorInstalled) return;
  window.__demodayCursorInstalled = true;

  const ID = "__demoday_cursor_layer";
  let layer, dot, ripple, ring;

  function build() {
    if (document.getElementById(ID)) return;
    layer = document.createElement("div");
    layer.id = ID;
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, {
      position: "fixed", inset: "0", pointerEvents: "none",
      zIndex: "2147483647", contain: "layout style size",
    });

    // The pointer itself: a macOS-ish arrow drawn as an SVG so it stays crisp
    // at any device pixel ratio and never depends on a font or image loading.
    dot = document.createElement("div");
    Object.assign(dot.style, {
      position: "absolute", left: "0", top: "0", width: "24px", height: "24px",
      transform: "translate(-2px,-2px)", willChange: "transform",
      filter: "drop-shadow(0 2px 3px rgba(0,0,0,.45))",
    });
    dot.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">' +
      '<path d="M4 2 L4 18 L8.5 13.8 L11.2 20.4 L14 19.2 L11.3 12.8 L17.5 12.6 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';

    ripple = document.createElement("div");
    Object.assign(ripple.style, {
      position: "absolute", left: "0", top: "0", width: "0", height: "0",
      borderRadius: "50%", border: "2px solid rgba(91,141,239,.95)",
      background: "rgba(91,141,239,.18)", opacity: "0",
      transform: "translate(-50%,-50%)", willChange: "width,height,opacity",
    });

    ring = document.createElement("div");
    Object.assign(ring.style, {
      position: "absolute", left: "0", top: "0", width: "0", height: "0",
      borderRadius: "10px", border: "3px solid rgba(91,141,239,.95)",
      boxShadow: "0 0 0 9999px rgba(0,0,0,0)", opacity: "0",
      transition: "opacity .18s ease", willChange: "opacity",
    });

    layer.append(ripple, ring, dot);
    (document.body || document.documentElement).appendChild(layer);
  }

  // Pages can replace document.body wholesale (SPA hydration, framework mounts).
  // Re-attach if our layer disappears.
  function ensure() {
    if (!document.getElementById(ID)) build();
  }

  const state = { x: -100, y: -100, wa: null };

  function place(x, y) {
    state.x = x; state.y = y;
    ensure();
    // A running Web Animation with fill:forwards would override an inline style,
    // so it has to be cancelled before we can place the cursor directly.
    if (state.wa) { try { state.wa.cancel(); } catch (e) {} state.wa = null; }
    dot.style.transform = "translate(" + x + "px," + y + "px)";
  }

  window.__demodayCursor = {
    /** Jump instantly. */
    place,

    position: () => ({ x: state.x, y: state.y }),

    /**
     * Animate through a precomputed path: [{x, y, atMs}], total durationMs.
     *
     * Uses the Web Animations API, NOT requestAnimationFrame, and is deliberately
     * FIRE-AND-FORGET (returns undefined, never a Promise).
     *
     * Both of those are hard-won. The first version ran a rAF loop and returned a
     * Promise the runner awaited. Two things went wrong:
     *
     *   1. rAF does not reliably fire under headless screencast, so the drawn
     *      cursor sat frozen at its start position for an entire take while the
     *      run itself looked successful — the worst kind of failure.
     *   2. Awaiting a page-side Promise meant page.evaluate could block forever
     *      when the page stopped servicing script, hanging the whole capture.
     *
     * WAAPI transform animations are driven by the compositor, so they play
     * whether or not rAF is being serviced. The easing is already baked into the
     * spacing of the points array, hence linear here.
     */
    animate(points, durationMs) {
      ensure();
      if (!points || points.length === 0) return;
      if (state.wa) { try { state.wa.cancel(); } catch (e) {} state.wa = null; }

      const last = points[points.length - 1];
      const keyframes = points.map((p) => ({
        transform: "translate(" + p.x + "px," + p.y + "px)",
        offset: Math.min(1, Math.max(0, (p.atMs || 0) / Math.max(1, durationMs))),
      }));

      try {
        state.wa = dot.animate(keyframes, {
          duration: Math.max(1, durationMs),
          easing: "linear",
          fill: "forwards",
        });
      } catch (e) {
        // No WAAPI: fall back to snapping there. Still correct, just not pretty.
        dot.style.transform = "translate(" + last.x + "px," + last.y + "px)";
      }

      // Report the destination immediately so a ripple fired after the glide
      // lands in the right place even if the animation is still settling.
      state.x = last.x;
      state.y = last.y;
      // No return value: page.evaluate resolves immediately.
    },

    /** Click feedback at the current position. */
    click(durationMs = 420) {
      ensure();
      const x = state.x, y = state.y;
      ripple.style.transition = "none";
      ripple.style.left = x + "px";
      ripple.style.top = y + "px";
      ripple.style.width = "0px";
      ripple.style.height = "0px";
      ripple.style.opacity = "1";
      // Force a reflow so the transition below actually runs from zero.
      void ripple.offsetWidth;
      ripple.style.transition = "width " + durationMs + "ms ease-out, height " +
        durationMs + "ms ease-out, opacity " + durationMs + "ms ease-out";
      ripple.style.width = "54px";
      ripple.style.height = "54px";
      ripple.style.opacity = "0";
    },

    /** Draw an emphasis ring around a rect; pass null to clear. */
    ring(rect) {
      ensure();
      if (!rect) { ring.style.opacity = "0"; return; }
      const pad = 6;
      ring.style.left = (rect.x - pad) + "px";
      ring.style.top = (rect.y - pad) + "px";
      ring.style.width = (rect.width + pad * 2) + "px";
      ring.style.height = (rect.height + pad * 2) + "px";
      ring.style.opacity = "1";
    },

    /** Hide the pointer for scenes that shouldn't show one. */
    hide() { ensure(); dot.style.opacity = "0"; },
    show() { ensure(); dot.style.opacity = "1"; },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build, { once: true });
  } else {
    build();
  }
})();
`;

/**
 * CSS injected alongside the cursor to make recordings deterministic.
 * Caret blink and scroll animation both cause frame-to-frame noise that makes
 * a clip look unstable and hurts video compression for no benefit.
 */
export const STABILISE_CSS = `
  * { caret-color: transparent !important; }
  html { scroll-behavior: auto !important; }
`;
