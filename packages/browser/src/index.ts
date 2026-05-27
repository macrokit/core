export type {
  ActionItem,
  ActionMenu,
  ActionRole,
  AnnotatedScreenshot,
  BrowserService,
} from "./types.js";

export {
  PlaywrightBrowserService,
  type PlaywrightBrowserServiceOptions,
} from "./playwright-service.js";

// DOM scripts are exported so adopters can inject custom variants or
// reuse the collector under jsdom for tests.
export {
  collectInteractiveElements,
  injectBadges,
  removeBadges,
  type DomActionItem,
} from "./dom-scripts.js";
