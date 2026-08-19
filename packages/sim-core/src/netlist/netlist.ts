/**
 * Netlist: from "the user wired this to that" to circuit nodes.
 *
 * The canvas deals in terminals -- a pin on a part, a hole in a breadboard, the end of a wire.
 * The solver deals in nodes. Any set of terminals joined by wires or by a breadboard's internal
 * strips is one node, and working that out is a union-find problem, not a graph traversal.
 *
 * Doing this properly is what makes the breadboard physical rather than decorative: plugging a leg
 * into row 12A really does connect it to 12B through 12E, and really does not connect it to 12F.
 */
import { GROUND } from '../analog/mna.js';

export class Netlist {
  /** Union-find parent pointers, keyed by terminal id. */
  private readonly parent = new Map<string, string>();
  /** Union-by-size, to keep the trees flat. */
  private readonly size = new Map<string, number>();
  /** Terminals declared to be ground. */
  private readonly grounded = new Set<string>();

  /** Declare a terminal. Idempotent, so callers need not track what they have added. */
  add(terminal: string): string {
    if (!this.parent.has(terminal)) {
      this.parent.set(terminal, terminal);
      this.size.set(terminal, 1);
    }
    return terminal;
  }

  /** True if the terminal has been declared. */
  has(terminal: string): boolean {
    return this.parent.has(terminal);
  }

  /** Every declared terminal. */
  get terminals(): readonly string[] {
    return [...this.parent.keys()];
  }

  /** Join two terminals into one electrical node. Declares either if needed. */
  connect(a: string, b: string): void {
    const rootA = this.find(this.add(a));
    const rootB = this.find(this.add(b));
    if (rootA === rootB) return;

    const sizeA = this.size.get(rootA)!;
    const sizeB = this.size.get(rootB)!;
    const [large, small] = sizeA >= sizeB ? [rootA, rootB] : [rootB, rootA];
    this.parent.set(small, large);
    this.size.set(large, sizeA + sizeB);
  }

  /** Connect a whole run of terminals, as a breadboard strip does. */
  connectAll(terminals: readonly string[]): void {
    for (let i = 1; i < terminals.length; i++) {
      this.connect(terminals[0]!, terminals[i]!);
    }
  }

  /** Mark a terminal as the ground reference. Everything joined to it becomes ground. */
  markGround(terminal: string): void {
    this.grounded.add(this.add(terminal));
  }

  /** True when two terminals are electrically the same point. */
  areConnected(a: string, b: string): boolean {
    if (!this.has(a) || !this.has(b)) return false;
    return this.find(a) === this.find(b);
  }

  /** Canonical representative for a terminal's net. */
  netOf(terminal: string): string {
    if (!this.has(terminal)) throw new Error(`Unknown terminal "${terminal}"`);
    return this.find(terminal);
  }

  /** Every distinct net, as a list of the terminals in it. */
  nets(): Map<string, string[]> {
    const nets = new Map<string, string[]>();
    for (const terminal of this.parent.keys()) {
      const root = this.find(terminal);
      const members = nets.get(root);
      if (members) members.push(terminal);
      else nets.set(root, [terminal]);
    }
    return nets;
  }

  /**
   * Allocate a circuit node per net.
   *
   * Nets containing a grounded terminal map to `GROUND` rather than to a node of their own, which
   * is what makes ground the reference instead of one more unknown in the matrix.
   *
   * A breadboard declares hundreds of holes, and a node for each unused strip would be a row and
   * column of matrix that no device ever touches. Dense factorisation is cubic, so that is not
   * free: a half-size board alone would take a 20-node circuit past 100. Pass `isLive` to allocate
   * only for nets something is actually plugged into.
   *
   * @param allocate Called once per non-ground net; supply `circuit.addNode()`.
   * @param isLive Optional filter. A net with no live terminal is omitted entirely.
   * @returns Terminal id to circuit node, for every terminal in an allocated net.
   */
  resolve(allocate: () => number, isLive?: (terminal: string) => boolean): Map<string, number> {
    const netToNode = new Map<string, number>();
    const result = new Map<string, number>();

    // Ground first, so a net is never allocated a node and then found to be grounded.
    for (const terminal of this.grounded) {
      netToNode.set(this.find(terminal), GROUND);
    }

    // Which nets contain something worth solving for.
    let liveNets: Set<string> | undefined;
    if (isLive) {
      liveNets = new Set(this.grounded.size > 0 ? [...this.grounded].map((t) => this.find(t)) : []);
      for (const terminal of this.parent.keys()) {
        if (isLive(terminal)) liveNets.add(this.find(terminal));
      }
    }

    for (const terminal of this.parent.keys()) {
      const root = this.find(terminal);
      if (liveNets && !liveNets.has(root)) continue;

      let node = netToNode.get(root);
      if (node === undefined) {
        node = allocate();
        netToNode.set(root, node);
      }
      result.set(terminal, node);
    }

    return result;
  }

  /** Path compression on lookup, which is what keeps this near constant time. */
  private find(terminal: string): string {
    let root = terminal;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Second pass: point everything on the path straight at the root.
    let cursor = terminal;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }
}
