// Windows runtime resolver requires the native boundary to be an artifact inside the
// staged Helper root. Keep package resolution here so the host process never loads xa11y.
export async function loadXa11y() {
  return await import("@crowecawcaw/xa11y");
}

export default loadXa11y;
