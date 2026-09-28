const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);

export function resolveVerificationTarget(explicitTarget, architecture = process.arch) {
  if (explicitTarget !== undefined) {
    if (!/^linux-(?:x64|arm64)$/.test(explicitTarget)) {
      throw new Error(
        `Invalid --target: ${explicitTarget}; verify-remote-ssh only accepts Linux targets`,
      );
    }
    return explicitTarget;
  }
  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported host architecture for verify-remote-ssh: ${architecture}`);
  }
  return `linux-${architecture}`;
}

export function dockerPlatformForTarget(target) {
  const architecture = target === "linux-x64" ? "amd64" : target === "linux-arm64" ? "arm64" : null;
  if (!architecture) throw new Error(`Unsupported Linux verification target: ${target}`);
  return `linux/${architecture}`;
}
