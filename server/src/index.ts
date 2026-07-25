import { config } from "./config.js";
import { initDatabase } from "./db/index.js";
import { registerMarketDataTools } from "./tools/marketData.js";
import { registerExecutionTools } from "./tools/executionTools.js";
import { resumeLinkIfPresent } from "./services/robinhoodMcp.js";
import { createApp } from "./app.js";

initDatabase();
registerMarketDataTools();
registerExecutionTools();
resumeLinkIfPresent();

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(`Server listening on http://${config.host}:${config.port}`);
});
