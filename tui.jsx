/** @jsxImportSource @opentui/solid */
import quotaModule from "@slkiser/opencode-quota/tui";
import { MODEL_USAGE_SIDEBAR_ORDER, createUpstreamTuiApi } from "./integration.js";
import { ModelUsagePanel } from "./panel.jsx";

const tui = async (api, options, meta) => {
  await quotaModule.tui(createUpstreamTuiApi(api), options, meta);
  api.slots.register({
    order: MODEL_USAGE_SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props) {
        return <ModelUsagePanel api={api} sessionID={props.session_id} />;
      },
    },
  });
};

export default { id: "local-opencode-model-usage", tui };
