// CLI wrapper: npx tsx server/test/run-mock-robinhood.ts [port]
import { startMockRobinhood } from "./mockRobinhoodMcp.js";

const port = Number(process.argv[2]) || 9097;
const mock = await startMockRobinhood(port);
console.log(`mock robinhood mcp on ${mock.url}`);
