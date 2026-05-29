import { loadConfig } from './config';
import { createApp } from './app';

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, () => {
  console.log(`receiver listening on :${config.port}`);
  console.log(`allowed repos: ${[...config.allowedRepos].join(', ')}`);
  console.log(`trigger label: "${config.triggerLabel}"`);
  console.log(`status label:  "${config.statusLabel}"`);
  console.log(`bot mention:   "@${config.botMention}"`);
});