import type { Transition } from 'motion/react';

/** Crisp compositor-only spring for anchored bug popovers and floating overlays */
export const POPOVER_SPRING: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 32,
  mass: 0.75,
};

/** Smooth spring for the mobile frosted-glass navigation drawer */
export const DRAWER_SPRING: Transition = {
  type: 'spring',
  stiffness: 360,
  damping: 34,
  mass: 0.85,
};

/** Calm, restrained transition for top-level views and dashboard mode switches */
export const VIEW_TRANSITION: Transition = {
  duration: 0.18,
  ease: [0.22, 1, 0.36, 1],
};

/** Smooth disclosure transition for collapsible panels, test suites, and confidence breakdowns */
export const PANEL_TRANSITION: Transition = {
  duration: 0.2,
  ease: [0.22, 1, 0.36, 1],
};
