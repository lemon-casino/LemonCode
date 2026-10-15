import { createSecureServer } from "node:http2";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import {
  createProviderNetworkTransport,
  getProviderNetworkDiagnostics,
} from "@lcode/provider-node/network";
import { installCliProcessErrorBoundary } from "../src/process-errors.js";
import { createProtocolProcessLifecycle } from "../src/protocol-lifecycle.js";

const [directory, kind] = process.argv.slice(2);
const forge = createRequire(
  new URL("../../../../../packages/services/package.json", import.meta.url),
)("node-forge");
const keys = forge.pki.rsa.generateKeyPair(2048);
const certificate = forge.pki.createCertificate();
certificate.publicKey = keys.publicKey;
certificate.serialNumber = "01";
certificate.validity.notBefore = new Date(Date.now() - 60_000);
certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
certificate.setSubject([{ name: "commonName", value: "Fatal fixture" }]);
certificate.setIssuer(certificate.subject.attributes);
certificate.setExtensions([
  { name: "basicConstraints", cA: true },
  { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
]);
certificate.sign(keys.privateKey, forge.md.sha256.create());
const cert = forge.pki.certificateToPem(certificate);
const caCertPath = join(directory!, "ca.pem");
await writeFile(caCertPath, cert);
const server = createSecureServer({ cert, key: forge.pki.privateKeyToPem(keys.privateKey) });
server.on("stream", (stream) => {
  stream.on("error", () => {});
  stream.resume();
  stream.respond({ ":status": 200, "content-type": "text/event-stream" });
  stream.write("data: waiting\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Fixture did not listen");
const owner = createProviderNetworkTransport(async () => ({ caCertPath, http2: "negotiate" }));
const lifecycle = createProtocolProcessLifecycle();
installCliProcessErrorBoundary({
  onFatal: (reason, errorId) => {
    lifecycle.requestShutdown(
      new Error("Fixture fatal", { cause: reason }),
      1,
      "runtime_failure",
      undefined,
      errorId,
    );
    void (async () => {
      await owner.disposeAndWait();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.stdout.write(
        JSON.stringify({
          errorId,
          closeErrorId: lifecycle.shutdownContext?.errorId,
          phase: getProviderNetworkDiagnostics().at(-1)?.phase,
          activeRequests: owner.activeRequestCount,
        }) + "\n",
      );
      await lifecycle.complete(1);
    })().catch(() => process.exit(2));
  },
});
await owner.fetch(`https://127.0.0.1:${address.port}`, { method: "POST", body: "{}" });
const error = Object.assign(
  new Error("Fixture fatal assertion", {
    cause: Object.assign(new Error("Fixture stream cause"), { code: "ERR_FIXTURE_STREAM" }),
  }),
  { code: "ERR_ASSERTION" },
);
error.stack = `AssertionError: Fixture fatal assertion\n${"x".repeat(30_000)}\n    at dependency (fixture.js:1:1)\n    at owner (fixture.js:2:1)`;
if (kind === "uncaughtException")
  setImmediate(() => {
    throw error;
  });
else void Promise.reject(error);
