import { createApp } from "./app";
import { getApiPort, getHost } from "./config";

const app = createApp();
const port = getApiPort();
const host = getHost();

app.listen(port, host, () => {
  console.log(`Agent Board API listening on http://${host}:${port}`);
});
