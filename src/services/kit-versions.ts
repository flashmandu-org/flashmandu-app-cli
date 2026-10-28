/**
 * Single source of truth for the bridge SDK versions this CLI vendors and
 * pins apps to. Bump both entries here (and re-run the tgz packing step —
 * see the consolidation plan's Phase A) on every kit release; `kit status`
 * and `kit sync` read only from this map.
 */
export const PINNED_KITS: Record<string, string> = {
  '@flashmandu/app-bridge': '0.6.6',
  '@flashmandu/app-bridge-ui': '0.7.1',
};
