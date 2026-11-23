import { resolveCeloRuntime } from "./chain.js";
import { buildOracleApp } from "./oracle-bootstrap.js";

let app;
try {
  app = buildOracleApp();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}

const celo = resolveCeloRuntime();
const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(
    `VetGate oracle listening on :${port} (Celo ${celo.network} chainId=${celo.chainId})`,
  );
});