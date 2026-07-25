import { buildServer } from '../api/server.ts';

const portArg = process.argv.find((a) => a.startsWith('--port='))?.split('=')[1];
const port = portArg === undefined ? 8080 : Number(portArg);

const app = buildServer();
app.listen({ port, host: '127.0.0.1' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`API listening on ${address}`);
});
