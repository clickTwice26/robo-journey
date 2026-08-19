/**
 * Netlist and breadboard topology.
 *
 * These tests encode what a breadboard physically is. If the centre-channel split is wrong here,
 * every circuit built on the canvas is wrong in a way that looks like a solver bug three layers up.
 */
import { describe, expect, it } from 'vitest';
import { Circuit, GROUND } from '../src/index.js';
import { Netlist } from '../src/netlist/netlist.js';
import {
  FULL_SIZE_BREADBOARD,
  HALF_SIZE_BREADBOARD,
  MINI_BREADBOARD,
  addBreadboard,
  boardRows,
  breadboardHoles,
  channelBounds,
  holeId,
  railHoleId,
  railOffset,
  railSegmentOf,
  rowOffset,
} from '../src/netlist/breadboard.js';

describe('Netlist', () => {
  it('joins two terminals into one net', () => {
    const net = new Netlist();
    net.connect('a', 'b');
    expect(net.areConnected('a', 'b')).toBe(true);
  });

  it('is transitive, as wire chains are', () => {
    const net = new Netlist();
    net.connect('a', 'b');
    net.connect('b', 'c');
    net.connect('c', 'd');
    expect(net.areConnected('a', 'd')).toBe(true);
  });

  it('keeps unrelated terminals apart', () => {
    const net = new Netlist();
    net.connect('a', 'b');
    net.connect('c', 'd');
    expect(net.areConnected('a', 'c')).toBe(false);
  });

  it('reports nothing connected for undeclared terminals', () => {
    const net = new Netlist();
    expect(net.areConnected('nope', 'also-nope')).toBe(false);
  });

  it('is idempotent when the same connection is made twice', () => {
    const net = new Netlist();
    net.connect('a', 'b');
    net.connect('a', 'b');
    net.connect('b', 'a');
    expect(net.nets().size).toBe(1);
  });

  it('groups terminals into distinct nets', () => {
    const net = new Netlist();
    net.connectAll(['a', 'b', 'c']);
    net.connectAll(['x', 'y']);
    net.add('lonely');

    const nets = net.nets();
    expect(nets.size).toBe(3);
    expect([...nets.values()].map((m) => m.length).sort()).toEqual([1, 2, 3]);
  });

  describe('resolving to circuit nodes', () => {
    it('gives every terminal in a net the same node', () => {
      const net = new Netlist();
      net.connectAll(['a', 'b', 'c']);
      const circuit = new Circuit();
      const nodes = net.resolve(() => circuit.addNode());

      expect(nodes.get('a')).toBe(nodes.get('b'));
      expect(nodes.get('b')).toBe(nodes.get('c'));
    });

    it('gives distinct nets distinct nodes', () => {
      const net = new Netlist();
      net.connect('a', 'b');
      net.connect('x', 'y');
      const circuit = new Circuit();
      const nodes = net.resolve(() => circuit.addNode());

      expect(nodes.get('a')).not.toBe(nodes.get('x'));
      expect(circuit.nodes).toBe(2);
    });

    it('maps anything joined to a grounded terminal to GROUND', () => {
      const net = new Netlist();
      net.connectAll(['gnd', 'a', 'b']);
      net.markGround('gnd');
      const circuit = new Circuit();
      const nodes = net.resolve(() => circuit.addNode());

      expect(nodes.get('a')).toBe(GROUND);
      expect(nodes.get('b')).toBe(GROUND);
      // Ground must not consume a matrix row.
      expect(circuit.nodes).toBe(0);
    });

    it('grounds a net regardless of connection order', () => {
      const net = new Netlist();
      net.markGround('gnd');
      net.connect('a', 'gnd');
      const circuit = new Circuit();
      expect(net.resolve(() => circuit.addNode()).get('a')).toBe(GROUND);
    });
  });
});

describe('breadboard topology', () => {
  const BB = 'bb1';

  function halfBoard(): Netlist {
    const net = new Netlist();
    addBreadboard(net, BB, HALF_SIZE_BREADBOARD);
    return net;
  }

  it('connects the five holes of a column above the channel', () => {
    const net = halfBoard();
    for (const row of ['B', 'C', 'D', 'E'] as const) {
      expect(net.areConnected(holeId(BB, 12, 'A'), holeId(BB, 12, row))).toBe(true);
    }
  });

  it('connects the five holes of a column below the channel', () => {
    const net = halfBoard();
    for (const row of ['G', 'H', 'I', 'J'] as const) {
      expect(net.areConnected(holeId(BB, 12, 'F'), holeId(BB, 12, row))).toBe(true);
    }
  });

  it('does NOT connect across the centre channel', () => {
    // The single most important property of a breadboard. An IC straddles the channel precisely
    // because its two rows of legs must stay separate.
    const net = halfBoard();
    expect(net.areConnected(holeId(BB, 12, 'E'), holeId(BB, 12, 'F'))).toBe(false);
    expect(net.areConnected(holeId(BB, 12, 'A'), holeId(BB, 12, 'J'))).toBe(false);
  });

  it('does not connect adjacent columns', () => {
    const net = halfBoard();
    expect(net.areConnected(holeId(BB, 12, 'A'), holeId(BB, 13, 'A'))).toBe(false);
  });

  it('runs power rails the length of a segment', () => {
    const net = halfBoard();
    // Half-size board split in two: columns 1-15 share a segment.
    expect(net.areConnected(railHoleId(BB, 'top', 'positive', 1), railHoleId(BB, 'top', 'positive', 15))).toBe(true);
  });

  it('breaks power rails in the middle, as most real boards do', () => {
    // The classic "why is half my circuit dead". Modelled, not smoothed over.
    const net = halfBoard();
    expect(
      net.areConnected(railHoleId(BB, 'top', 'positive', 1), railHoleId(BB, 'top', 'positive', 30)),
    ).toBe(false);
  });

  it('keeps a continuous rail continuous when the spec says so', () => {
    const net = new Netlist();
    addBreadboard(net, BB, { columns: 30, powerRails: true, railSegments: 1 });
    expect(
      net.areConnected(railHoleId(BB, 'top', 'positive', 1), railHoleId(BB, 'top', 'positive', 30)),
    ).toBe(true);
  });

  it('keeps the + and - rails separate', () => {
    const net = halfBoard();
    expect(
      net.areConnected(railHoleId(BB, 'top', 'positive', 5), railHoleId(BB, 'top', 'negative', 5)),
    ).toBe(false);
  });

  it('keeps the top and bottom rails separate', () => {
    // They are only joined if the user wires them, which is exactly the point.
    const net = halfBoard();
    expect(
      net.areConnected(railHoleId(BB, 'top', 'positive', 5), railHoleId(BB, 'bottom', 'positive', 5)),
    ).toBe(false);
  });

  it('assigns rail segments by column', () => {
    expect(railSegmentOf(HALF_SIZE_BREADBOARD, 1)).toBe(0);
    expect(railSegmentOf(HALF_SIZE_BREADBOARD, 15)).toBe(0);
    expect(railSegmentOf(HALF_SIZE_BREADBOARD, 16)).toBe(1);
    expect(railSegmentOf(HALF_SIZE_BREADBOARD, 30)).toBe(1);
  });

  it('enumerates the right number of holes', () => {
    // Half-size: 30 columns x 10 rows, plus 4 rails x 30 = 420 tie points.
    expect(breadboardHoles(BB, HALF_SIZE_BREADBOARD)).toHaveLength(30 * 10 + 4 * 30);
    expect(breadboardHoles(BB, FULL_SIZE_BREADBOARD)).toHaveLength(63 * 10 + 4 * 63);
  });

  it('keeps two boards on the same canvas electrically independent', () => {
    const net = new Netlist();
    addBreadboard(net, 'bb1', HALF_SIZE_BREADBOARD);
    addBreadboard(net, 'bb2', HALF_SIZE_BREADBOARD);
    expect(net.areConnected(holeId('bb1', 5, 'A'), holeId('bb2', 5, 'A'))).toBe(false);
  });

  describe('the mini board', () => {
    function miniBoard(): Netlist {
      const net = new Netlist();
      addBreadboard(net, BB, MINI_BREADBOARD);
      return net;
    }

    it('has 17 columns and 170 tie points', () => {
      expect(breadboardHoles(BB, MINI_BREADBOARD)).toHaveLength(17 * 10);
    });

    it('still splits at the centre channel', () => {
      const net = miniBoard();
      expect(net.areConnected(holeId(BB, 5, 'A'), holeId(BB, 5, 'E'))).toBe(true);
      expect(net.areConnected(holeId(BB, 5, 'E'), holeId(BB, 5, 'F'))).toBe(false);
    });

    it('has no power rails at all', () => {
      const net = miniBoard();
      // A mini board genuinely has none, so asking for a rail hole must find nothing rather than
      // silently inventing one.
      expect(net.has(railHoleId(BB, 'top', 'positive', 1))).toBe(false);
      expect(railOffset(MINI_BREADBOARD, 'top', 'positive')).toBeNull();
    });
  });

  describe('physical layout', () => {
    it('starts numbered rows higher on a board without rails', () => {
      // No rail to leave room for, so row A moves up two pitches.
      expect(rowOffset(HALF_SIZE_BREADBOARD, 'A')).toBe(3);
      expect(rowOffset(MINI_BREADBOARD, 'A')).toBe(1);
    });

    it('leaves exactly one pitch of channel between rows E and F', () => {
      for (const spec of [MINI_BREADBOARD, HALF_SIZE_BREADBOARD, FULL_SIZE_BREADBOARD]) {
        expect(rowOffset(spec, 'F') - rowOffset(spec, 'E')).toBe(2);
      }
    });

    it('spaces rows one pitch apart within each half', () => {
      for (const spec of [MINI_BREADBOARD, HALF_SIZE_BREADBOARD]) {
        expect(rowOffset(spec, 'B') - rowOffset(spec, 'A')).toBe(1);
        expect(rowOffset(spec, 'J') - rowOffset(spec, 'I')).toBe(1);
      }
    });

    it('puts the channel between rows E and F, touching neither', () => {
      const spec = HALF_SIZE_BREADBOARD;
      const channel = channelBounds(spec);
      expect(channel.top).toBeGreaterThan(rowOffset(spec, 'E'));
      expect(channel.top + channel.height).toBeLessThan(rowOffset(spec, 'F'));
    });

    it('puts the bottom rails below row J', () => {
      const spec = HALF_SIZE_BREADBOARD;
      expect(railOffset(spec, 'bottom', 'positive')!).toBeGreaterThan(rowOffset(spec, 'J'));
      expect(railOffset(spec, 'bottom', 'negative')!).toBeLessThan(boardRows(spec));
    });

    it('keeps every row and rail inside the board', () => {
      for (const spec of [MINI_BREADBOARD, HALF_SIZE_BREADBOARD, FULL_SIZE_BREADBOARD]) {
        const rows = boardRows(spec);
        expect(rowOffset(spec, 'J')).toBeLessThan(rows);
        if (spec.powerRails) {
          expect(railOffset(spec, 'bottom', 'negative')!).toBeLessThan(rows);
          expect(railOffset(spec, 'top', 'positive')!).toBeGreaterThan(0);
        }
      }
    });
  });

  it('lets a wire bridge the channel when the user asks for it', () => {
    const net = halfBoard();
    net.connect(holeId(BB, 12, 'E'), holeId(BB, 12, 'F'));
    expect(net.areConnected(holeId(BB, 12, 'A'), holeId(BB, 12, 'J'))).toBe(true);
  });
});
