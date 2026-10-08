export default function inspectWorker() {
  return {
    execArgv: process.execArgv,
    pollutedEnvironment: process.env.LCODE_SECURITY_POLLUTION_PROBE ?? null,
  };
}
