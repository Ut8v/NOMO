import { config } from "./config.js";
import { initDatabase } from "./db/index.js";
import { ensureSearchIndex } from "./db/search.js";
import { registerMarketDataTools } from "./tools/marketData.js";
import { registerExecutionTools } from "./tools/executionTools.js";
import { registerLearningTools } from "./tools/learningTools.js";
import { registerResearchTool } from "./tools/researchTool.js";
import { registerEdgarTools } from "./tools/edgarTools.js";
import { registerBacktestTool } from "./tools/backtestTool.js";
import { registerNewsTool } from "./tools/newsTool.js";
import { resumeLinkIfPresent } from "./services/robinhoodMcp.js";
import { createApp } from "./app.js";

initDatabase();
ensureSearchIndex();
registerMarketDataTools();
registerExecutionTools();
registerLearningTools();
registerResearchTool();
registerEdgarTools();
registerBacktestTool();
registerNewsTool();
resumeLinkIfPresent();

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(`Server listening on http://${config.host}:${config.port}`);
});
