import { createSearchMessages } from "./messages.js";
import { defineSessionSearchPanel } from "./panel.js";

const plugin = {
  apiVersion: 5,
  name: "Session search",
  activate(context) {
    const { html, svg, localization } = context;
    if (localization === undefined) throw new Error("Session search requires a localization-capable PI WEB host");
    const messages = localization.registerMessages("panel", createSearchMessages(localization));
    defineSessionSearchPanel();
    return {
      contributions: {
        applicationPanels: [
          {
            id: "session-search",
            order: 40,
            get title() {
              return messages.t("title");
            },
            icon: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m15.5 15.5 4.5 4.5"></path></svg>`,
            render: (panelContext) => html`<session-search-panel .context=${panelContext} .messages=${messages} .localization=${localization}></session-search-panel>`,
          },
        ],
      },
    };
  },
};

export default plugin;
