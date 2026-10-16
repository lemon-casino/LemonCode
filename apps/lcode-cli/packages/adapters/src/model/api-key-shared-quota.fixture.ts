import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
const [directory, command, encoded] = process.argv.slice(2);
const owner = new FileSharedQuotaCoordinator(directory!);
try {
  const handle = await owner.reserve(JSON.parse(encoded!));
  if (command === "dispatch" || command === "hold") await owner.dispatch(handle);
  process.stdout.write(JSON.stringify({ ok: true, handle }));
  if (command === "hold")
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: (error as { code?: string }).code }));
}
