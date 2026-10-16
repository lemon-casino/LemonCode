interface Node {
  key: number;
  priority: number;
  left?: Node;
  right?: Node;
}
const priority = (key: number) => {
  let value = (key | 0) + 0x9e3779b9;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
};
function merge(left?: Node, right?: Node): Node | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.priority < right.priority) {
    left.right = merge(left.right, right);
    return left;
  }
  right.left = merge(left, right.left);
  return right;
}
function insert(root: Node | undefined, node: Node): Node {
  if (!root) return node;
  if (node.key === root.key) return root;
  if (node.key < root.key) {
    root.left = insert(root.left, node);
    if (root.left.priority < root.priority) {
      const top = root.left;
      root.left = top.right;
      top.right = root;
      return top;
    }
  } else {
    root.right = insert(root.right, node);
    if (root.right.priority < root.priority) {
      const top = root.right;
      root.right = top.left;
      top.left = root;
      return top;
    }
  }
  return root;
}
function remove(root: Node | undefined, key: number): Node | undefined {
  if (!root) return undefined;
  if (key === root.key) return merge(root.left, root.right);
  if (key < root.key) root.left = remove(root.left, key);
  else root.right = remove(root.right, key);
  return root;
}
/** 目录顺序的派生索引；只保存整数位置，凭据和调度状态不进入树。 */
export class RoutingOrderedSet {
  private root?: Node;
  size = 0;
  add(key: number): void {
    this.root = insert(this.root, { key, priority: priority(key) });
    this.size++;
  }
  delete(key: number): void {
    this.root = remove(this.root, key);
    this.size--;
  }
  first(from = 0): number | undefined {
    let node = this.root,
      found: number | undefined;
    while (node) {
      if (node.key >= from) {
        found = node.key;
        node = node.left;
      } else node = node.right;
    }
    return found ?? (from === 0 ? undefined : this.first());
  }
}
