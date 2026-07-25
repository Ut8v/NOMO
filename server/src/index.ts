import { config } from "./config.js";
import { initDatabase } from "./db/index.js";
import { registerMarketDataTools } from "./tools/marketData.js";
import { registerExecutionTools } from "./tools/executionTools.js";
import { registerLearningTools } from "./tools/learningTools.js";
import { resumeLinkIfPresent } from "./services/robinhoodMcp.js";
import { createApp } from "./app.js";

initDatabase();
registerMarketDataTools();
registerExecutionTools();
registerLearningTools();
resumeLinkIfPresent();

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(`Server listening on http://${config.host}:${config.port}`);
});
