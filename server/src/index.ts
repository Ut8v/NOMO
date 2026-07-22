import { config } from "./config.js";
import { initDatabase } from "./db/index.js";
import { createApp } from "./app.js";

initDatabase();

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(`Server listening on http://${config.host}:${config.port}`);
});
