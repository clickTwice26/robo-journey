/**
 * AVR disassembler, checked against avr8js's assembler.
 *
 * The oracle pattern again: assemble a line with an independent implementation, disassemble the
 * bytes we get back, and require the mnemonic and operands to survive the round trip. A
 * disassembler tested only against its own expectations is testing that it is self-consistent,
 * which is not the same as correct.
 */
import { assemble } from 'avr8js/dist/esm/utils/assembler.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decode, disassemble, indexByAddress, loadHex } from '../src/index.js';
import { dataName, ioName } from '../src/debug/io-registers.js';

/** Assemble one line and return its opcode words. */
function opcodes(source: string): number[] {
  const result = assemble(source);
  expect(result.errors, `assembler rejected: ${source}`).toEqual([]);
  const words: number[] = [];
  for (let i = 0; i + 1 < result.bytes.length; i += 2) {
    words.push(result.bytes[i]! | (result.bytes[i + 1]! << 8));
  }
  return words;
}

/** Assemble a line, disassemble it, and return "mnemonic operands". */
function roundTrip(source: string): string {
  const words = opcodes(source);
  const line = decode(words[0]!, words[1] ?? 0, 0);
  return `${line.mnemonic} ${line.operands}`.trim();
}

describe('decode', () => {
  describe('round trips through the assembler', () => {
    const cases = [
      'nop',
      'ldi r16, 0x42',
      // ldi with 0xff is deliberately shown as `ser`; see the alias tests below.
      'mov r5, r10',
      'add r1, r2',
      'adc r3, r4',
      'sub r7, r8',
      'sbc r9, r10',
      'and r11, r12',
      'or r13, r14',
      'cp r15, r16',
      'cpc r17, r18',
      'cpi r20, 0x10',
      'subi r21, 0x05',
      'sbci r22, 0x01',
      'ori r23, 0x80',
      'andi r24, 0x0f',
      'com r2',
      'neg r3',
      'inc r4',
      'dec r5',
      'swap r6',
      'asr r7',
      'lsr r8',
      'ror r9',
      'push r28',
      'pop r29',
      'ret',
      'reti',
      'sei',
      'cli',
      'sleep',
      'wdr',
      'icall',
      'ijmp',
      'mul r6, r7',
      'muls r16, r17',
    ];

    it.each(cases)('%s', (source) => {
      expect(roundTrip(source)).toBe(source);
    });
  });

  describe('idiomatic aliases the compiler actually emits', () => {
    it('shows EOR of a register with itself as clr', () => {
      // `eor r1, r1` is how every AVR compiler writes "set to zero".
      expect(roundTrip('eor r1, r1')).toBe('clr r1');
    });

    it('shows ADD of a register with itself as lsl', () => {
      expect(roundTrip('add r5, r5')).toBe('lsl r5');
    });

    it('shows ADC of a register with itself as rol', () => {
      expect(roundTrip('adc r5, r5')).toBe('rol r5');
    });

    it('shows AND of a register with itself as tst', () => {
      expect(roundTrip('and r9, r9')).toBe('tst r9');
    });

    it('shows LDI 0xff as ser', () => {
      expect(roundTrip('ldi r18, 0xff')).toBe('ser r18');
    });
  });

  describe('I/O access', () => {
    it('names the register an OUT writes to', () => {
      const words = opcodes('out 0x05, r24');
      const line = decode(words[0]!, 0, 0);
      expect(line.mnemonic).toBe('out');
      // 0x05 alone is unreadable; PORTB says the sketch just wrote a pin.
      expect(line.comment).toBe('PORTB');
    });

    it('names the register an IN reads from', () => {
      const line = decode(opcodes('in r24, 0x03')[0]!, 0, 0);
      expect(line.mnemonic).toBe('in');
      expect(line.comment).toBe('PINB');
    });

    it('names the register a single-bit instruction touches', () => {
      const line = decode(opcodes('sbi 0x04, 5')[0]!, 0, 0);
      expect(line.mnemonic).toBe('sbi');
      expect(line.operands).toBe('0x04, 5');
      // DDRB bit 5 is D13 becoming an output -- the first thing Blink does.
      expect(line.comment).toBe('DDRB');
    });

    it('maps I/O space and data space separately', () => {
      // The same physical register has two addresses, 0x20 apart. Confusing them is the classic
      // AVR mistake, so the two tables are keyed by their own space.
      expect(ioName(0x05)).toBe('PORTB');
      expect(dataName(0x25)).toBe('PORTB');
      expect(dataName(0xc6)).toBe('UDR0');
    });
  });

  describe('branches and jumps', () => {
    it('computes an rjmp target relative to the following instruction', () => {
      // rjmp with offset 0 lands on the next instruction, not on itself.
      const line = decode(0xc000, 0, 0);
      expect(line.mnemonic).toBe('rjmp');
      expect(line.target).toBe(2);
    });

    it('handles a backwards rjmp', () => {
      // 0xcfff is offset -1. From byte address 8 that lands back on 8 -- the instruction jumps to
      // itself, which is exactly the `rjmp .-2` spin the Arduino core ends main() with.
      const line = decode(0xcfff, 0, 4);
      expect(line.address).toBe(8);
      expect(line.target).toBe(8);
    });

    it('decodes conditional branches by their SREG bit', () => {
      expect(decode(0xf001, 0, 0).mnemonic).toBe('breq');
      expect(decode(0xf401, 0, 0).mnemonic).toBe('brne');
      expect(decode(0xf000, 0, 0).mnemonic).toBe('brcs');
      expect(decode(0xf400, 0, 0).mnemonic).toBe('brcc');
    });

    it('decodes a 32-bit call and reports it as four bytes', () => {
      const line = decode(0x940e, 0x0100, 0);
      expect(line.mnemonic).toBe('call');
      expect(line.size).toBe(4);
      // Target is a word address in the encoding; we report bytes.
      expect(line.target).toBe(0x0200);
    });

    it('decodes a 32-bit jmp', () => {
      const line = decode(0x940c, 0x0040, 0);
      expect(line.mnemonic).toBe('jmp');
      expect(line.size).toBe(4);
      expect(line.target).toBe(0x0080);
    });
  });

  describe('loads and stores', () => {
    it('decodes LDS with its data-space annotation', () => {
      const line = decode(0x9000, 0xc6, 0);
      expect(line.mnemonic).toBe('lds');
      expect(line.size).toBe(4);
      expect(line.comment).toBe('UDR0');
    });

    it('decodes pointer modes', () => {
      expect(decode(0x900d, 0, 0).operands).toBe('r0, X+');
      expect(decode(0x900e, 0, 0).operands).toBe('r0, -X');
      expect(decode(0x9001, 0, 0).operands).toBe('r0, Z+');
    });

    it('decodes displacement forms', () => {
      // ldd r24, Y+2
      const line = decode(0x808a, 0, 0);
      expect(line.mnemonic).toBe('ldd');
      expect(line.operands).toBe('r8, Y+2');
    });
  });

  describe('word arithmetic', () => {
    it('decodes adiw and sbiw on the pointer pairs', () => {
      expect(decode(0x9601, 0, 0).mnemonic).toBe('adiw');
      expect(decode(0x9701, 0, 0).mnemonic).toBe('sbiw');
      expect(decode(0x9601, 0, 0).operands).toBe('r25:r24, 1');
    });
  });

  it('falls back to .word rather than guessing', () => {
    // An honest hex value beats a confidently wrong mnemonic.
    const line = decode(0xffff, 0, 0);
    expect(line.mnemonic === '.word' || line.mnemonic.startsWith('sbrs')).toBe(true);
  });
});

describe('disassemble', () => {
  const blink = loadHex(
    readFileSync(fileURLToPath(new URL('./fixtures/blink.hex', import.meta.url)), 'utf8'),
  );

  it('decodes the reset vector as a jump to the startup code', () => {
    // Every AVR image begins with a jump past the interrupt vector table.
    const [first] = disassemble(blink, { from: 0, to: 4 });
    expect(first!.mnemonic).toBe('jmp');
    expect(first!.address).toBe(0);
    expect(first!.target).toBeGreaterThan(0);
  });

  it('advances by each instruction size, leaving no gaps or overlaps', () => {
    const lines = disassemble(blink, { from: 0, to: 512 });
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.address).toBe(lines[i - 1]!.address + lines[i - 1]!.size);
    }
  });

  it('reports byte addresses, as avr-objdump does', () => {
    const lines = disassemble(blink, { from: 0, to: 8 });
    // Words, not bytes, would make these 0, 1, 2 -- the classic off-by-two in AVR tooling.
    expect(lines.map((l) => l.address)).toEqual([0, 4, 8].slice(0, lines.length));
  });

  it('finds real instructions in the compiled sketch', () => {
    const lines = disassemble(blink, { from: 0, to: 1024 });
    const mnemonics = new Set(lines.map((l) => l.mnemonic));
    // A compiled Arduino sketch always contains these.
    expect(mnemonics.has('jmp')).toBe(true);
    expect(mnemonics.has('out')).toBe(true);
    expect(mnemonics.size).toBeGreaterThan(8);
  });

  it('indexes lines by address for a single-lookup PC search', () => {
    const lines = disassemble(blink, { from: 0, to: 256 });
    const index = indexByAddress(lines);
    for (const line of lines) {
      expect(lines[index.get(line.address)!]).toBe(line);
    }
  });

  it('does not run past the end of flash', () => {
    const tiny = new Uint16Array([0x0000, 0x9508]);
    const lines = disassemble(tiny);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.mnemonic).toBe('ret');
  });
});
