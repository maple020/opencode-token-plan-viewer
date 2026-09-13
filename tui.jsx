/** @jsxImportSource @opentui/solid */
import { TokenCheckerPanel } from "./quota-panel.jsx";

const tui = async (api) => {
  api.slots.register({
    order: 910,
    slots: {
      sidebar_content(_ctx, props) {
        return <TokenCheckerPanel api={api} sessionID={props.session_id} />;
      },
    },
  });
};

export default { id: "local-opencode-model-usage", tui };
