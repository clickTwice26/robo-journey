/**
 * AVR disassembler.
 *
 * Turns flash back into a listing so the debugger can show where the program counter actually is.
 * Covers the AVR5 core the ATmega328P implements; anything unrecognised falls back to `.word`
 * rather than guessing, because a confidently wrong mnemonic is worse than an honest hex value.
 *
 * Checked against avr8js's assembler in the tests: assemble a line, disassemble the bytes, and the
 * operands must come back. Using an independent implementation as the oracle is the same reason
 * `ml-matrix` guards the LU solver.
 *
 * Two address conventions meet here, and mixing them is the classic AVR debugging mistake. Flash is
 * addressed in 16-bit *words* by the program counter, but `avr-objdump` and every datasheet listing
 * use *byte* addresses. Everything this module exposes is in bytes; word addresses stay internal.
 */
import { dataName, ioName } from './io-registers.js';

export interface DisasmLine {
  /** Byte address, matching avr-objdump. */
  readonly address: number;
  /** The opcode words that make up this instruction. */
  readonly words: readonly number[];
  /** 2 or 4 bytes. */
  readonly size: number;
  readonly mnemonic: string;
  readonly operands: string;
  /** Destination byte address for a branch, jump or call. */
  readonly target?: number | undefined;
  /** Register name or other annotation that makes the line readable. */
  readonly comment?: string | undefined;
}

/** Condition names for BRBS/BRBC, indexed by SREG bit. */
const BRBS_NAMES = ['brcs', 'breq', 'brmi', 'brvs', 'brlt', 'brhs', 'brts', 'brie'];
const BRBC_NAMES = ['brcc', 'brne', 'brpl', 'brvc', 'brge', 'brhc', 'brtc', 'brid'];
/** SREG bit names for BSET/BCLR. */
const SET_NAMES = ['sec', 'sez', 'sen', 'sev', 'ses', 'seh', 'set', 'sei'];
const CLR_NAMES = ['clc', 'clz', 'cln', 'clv', 'cls', 'clh', 'clt', 'cli'];

const hex = (value: number, digits = 2): string =>
  `0x${(value >>> 0).toString(16).padStart(digits, '0')}`;

/** Sign-extend an n-bit value. */
function signed(value: number, bits: number): number {
  const sign = 1 << (bits - 1);
  return (value & (sign - 1)) - (value & sign);
}

/**
 * Decode one instruction at a word address.
 *
 * `next` is the following word, needed by the four 32-bit instructions (JMP, CALL, LDS, STS).
 */
export function decode(opcode: number, next: number, wordAddress: number): DisasmLine {
  const address = wordAddress * 2;
  const one = (mnemonic: string, operands = '', extra: Partial<DisasmLine> = {}): DisasmLine => ({
    address,
    words: [opcode],
    size: 2,
    mnemonic,
    operands,
    ...extra,
  });
  const two = (mnemonic: string, operands: string, extra: Partial<DisasmLine> = {}): DisasmLine => ({
    address,
    words: [opcode, next],
    size: 4,
    mnemonic,
    operands,
    ...extra,
  });

  // Common field extractions, named as the datasheet names them.
  const d5 = (opcode >> 4) & 0x1f;
  const r5 = ((opcode >> 5) & 0x10) | (opcode & 0x0f);
  const d4 = ((opcode >> 4) & 0x0f) + 16;
  const k8 = (((opcode >> 4) & 0xf0) | (opcode & 0x0f)) & 0xff;
  const b3 = opcode & 0x07;

  if (opcode === 0x0000) return one('nop');

  // --- 0000 ----------------------------------------------------------------------------------
  if ((opcode & 0xff00) === 0x0100) {
    const d = ((opcode >> 4) & 0x0f) * 2;
    const r = (opcode & 0x0f) * 2;
    return one('movw', `r${d + 1}:r${d}, r${r + 1}:r${r}`);
  }
  if ((opcode & 0xff00) === 0x0200) {
    return one('muls', `r${((opcode >> 4) & 0x0f) + 16}, r${(opcode & 0x0f) + 16}`);
  }
  if ((opcode & 0xff88) === 0x0300) return one('mulsu', `r${((opcode >> 4) & 7) + 16}, r${(opcode & 7) + 16}`);
  if ((opcode & 0xff88) === 0x0308) return one('fmul', `r${((opcode >> 4) & 7) + 16}, r${(opcode & 7) + 16}`);
  if ((opcode & 0xff88) === 0x0380) return one('fmuls', `r${((opcode >> 4) & 7) + 16}, r${(opcode & 7) + 16}`);
  if ((opcode & 0xff88) === 0x0388) return one('fmulsu', `r${((opcode >> 4) & 7) + 16}, r${(opcode & 7) + 16}`);

  if ((opcode & 0xfc00) === 0x0400) return one('cpc', `r${d5}, r${r5}`);
  if ((opcode & 0xfc00) === 0x0800) return one('sbc', `r${d5}, r${r5}`);
  if ((opcode & 0xfc00) === 0x0c00) {
    // ADD with both operands the same register is how a compiler writes a left shift.
    return d5 === r5 ? one('lsl', `r${d5}`) : one('add', `r${d5}, r${r5}`);
  }

  // --- 0001 / 0010 ---------------------------------------------------------------------------
  if ((opcode & 0xfc00) === 0x1000) return one('cpse', `r${d5}, r${r5}`);
  if ((opcode & 0xfc00) === 0x1400) return one('cp', `r${d5}, r${r5}`);
  if ((opcode & 0xfc00) === 0x1800) return one('sub', `r${d5}, r${r5}`);
  if ((opcode & 0xfc00) === 0x1c00) return d5 === r5 ? one('rol', `r${d5}`) : one('adc', `r${d5}, r${r5}`);
  if ((opcode & 0xfc00) === 0x2000) return d5 === r5 ? one('tst', `r${d5}`) : one('and', `r${d5}, r${r5}`);
  if ((opcode & 0xfc00) === 0x2400) return d5 === r5 ? one('clr', `r${d5}`) : one('eor', `r${d5}, r${r5}`);
  if ((opcode & 0xfc00) === 0x2800) return one('or', `r${d5}, r${r5}`);
  if ((opcode & 0xfc00) === 0x2c00) return one('mov', `r${d5}, r${r5}`);

  // --- Immediate forms, which only reach r16-r31 -----------------------------------------------
  if ((opcode & 0xf000) === 0x3000) return one('cpi', `r${d4}, ${hex(k8)}`);
  if ((opcode & 0xf000) === 0x4000) return one('sbci', `r${d4}, ${hex(k8)}`);
  if ((opcode & 0xf000) === 0x5000) return one('subi', `r${d4}, ${hex(k8)}`);
  if ((opcode & 0xf000) === 0x6000) return one('ori', `r${d4}, ${hex(k8)}`);
  if ((opcode & 0xf000) === 0x7000) return one('andi', `r${d4}, ${hex(k8)}`);
  if ((opcode & 0xf000) === 0xe000) {
    return k8 === 0xff ? one('ser', `r${d4}`) : one('ldi', `r${d4}, ${hex(k8)}`);
  }

  // --- LDD / STD with displacement --------------------------------------------------------------
  if ((opcode & 0xd000) === 0x8000) {
    const q = ((opcode >> 8) & 0x20) | ((opcode >> 7) & 0x18) | (opcode & 0x07);
    const pointer = opcode & 0x08 ? 'Y' : 'Z';
    const isStore = (opcode & 0x0200) !== 0;
    const reg = isStore ? r5AsStore(opcode) : d5;
    if (q === 0) {
      return isStore ? one('st', `${pointer}, r${reg}`) : one('ld', `r${reg}, ${pointer}`);
    }
    return isStore
      ? one('std', `${pointer}+${q}, r${reg}`)
      : one('ldd', `r${reg}, ${pointer}+${q}`);
  }

  // --- 1001 000x / 1001 001x: load and store with pointer modes --------------------------------
  if ((opcode & 0xfe0f) === 0x9000) {
    return two('lds', `r${d5}, ${hex(next, 4)}`, { comment: dataName(next) });
  }
  if ((opcode & 0xfe0f) === 0x9200) {
    return two('sts', `${hex(next, 4)}, r${d5}`, { comment: dataName(next) });
  }
  const pointerLoads: Record<number, string> = {
    0x1: 'Z+', 0x2: '-Z', 0x9: 'Y+', 0xa: '-Y', 0xc: 'X', 0xd: 'X+', 0xe: '-X',
  };
  if ((opcode & 0xfe00) === 0x9000) {
    const mode = opcode & 0x0f;
    if (mode === 0x0f) return one('pop', `r${d5}`);
    if (mode === 0x04) return one('lpm', `r${d5}, Z`);
    if (mode === 0x05) return one('lpm', `r${d5}, Z+`);
    if (mode === 0x06) return one('elpm', `r${d5}, Z`);
    if (mode === 0x07) return one('elpm', `r${d5}, Z+`);
    const pointer = pointerLoads[mode];
    if (pointer) return one('ld', `r${d5}, ${pointer}`);
  }
  if ((opcode & 0xfe00) === 0x9200) {
    const mode = opcode & 0x0f;
    if (mode === 0x0f) return one('push', `r${d5}`);
    const pointer = pointerLoads[mode];
    if (pointer) return one('st', `${pointer}, r${d5}`);
  }

  // --- 1001 010x: one-operand arithmetic and the control instructions --------------------------
  if ((opcode & 0xfe00) === 0x9400) {
    const mode = opcode & 0x0f;
    const unary: Record<number, string> = {
      0x0: 'com', 0x1: 'neg', 0x2: 'swap', 0x3: 'inc', 0x5: 'asr', 0x6: 'lsr', 0x7: 'ror', 0xa: 'dec',
    };

    if (opcode === 0x9409) return one('ijmp');
    if (opcode === 0x9509) return one('icall');
    if (opcode === 0x9508) return one('ret');
    if (opcode === 0x9518) return one('reti');
    if (opcode === 0x9588) return one('sleep');
    if (opcode === 0x9598) return one('break');
    if (opcode === 0x95a8) return one('wdr');
    if (opcode === 0x95c8) return one('lpm');
    if (opcode === 0x95e8) return one('spm');

    if ((opcode & 0xff8f) === 0x9408) return one(SET_NAMES[(opcode >> 4) & 7]!);
    if ((opcode & 0xff8f) === 0x9488) return one(CLR_NAMES[(opcode >> 4) & 7]!);

    // JMP and CALL carry a 22-bit target across two words.
    if ((opcode & 0xfe0e) === 0x940c) {
      const target = (((opcode & 0x01f0) >> 3) | (opcode & 0x01)) * 65536 + next;
      return two('jmp', hex(target * 2, 4), { target: target * 2 });
    }
    if ((opcode & 0xfe0e) === 0x940e) {
      const target = (((opcode & 0x01f0) >> 3) | (opcode & 0x01)) * 65536 + next;
      return two('call', hex(target * 2, 4), { target: target * 2 });
    }

    const mnemonic = unary[mode];
    if (mnemonic) return one(mnemonic, `r${d5}`);
  }

  // --- 1001 0110 / 0111: word arithmetic on the pointer pairs -----------------------------------
  if ((opcode & 0xff00) === 0x9600 || (opcode & 0xff00) === 0x9700) {
    const k = ((opcode >> 2) & 0x30) | (opcode & 0x0f);
    const pair = 24 + ((opcode >> 4) & 0x03) * 2;
    return one((opcode & 0x0100) === 0x0100 ? 'sbiw' : 'adiw', `r${pair + 1}:r${pair}, ${k}`);
  }

  // --- 1001 10xx: single-bit I/O -----------------------------------------------------------------
  if ((opcode & 0xfc00) === 0x9800) {
    const a = (opcode >> 3) & 0x1f;
    const names: Record<number, string> = { 0x0: 'cbi', 0x1: 'sbic', 0x2: 'sbi', 0x3: 'sbis' };
    const mnemonic = names[(opcode >> 8) & 0x03]!;
    return one(mnemonic, `${hex(a)}, ${b3}`, { comment: ioName(a) });
  }

  if ((opcode & 0xfc00) === 0x9c00) return one('mul', `r${d5}, r${r5}`);

  // --- IN / OUT ----------------------------------------------------------------------------------
  if ((opcode & 0xf800) === 0xb000) {
    const a = ((opcode >> 5) & 0x30) | (opcode & 0x0f);
    return one('in', `r${d5}, ${hex(a)}`, { comment: ioName(a) });
  }
  if ((opcode & 0xf800) === 0xb800) {
    const a = ((opcode >> 5) & 0x30) | (opcode & 0x0f);
    return one('out', `${hex(a)}, r${d5}`, { comment: ioName(a) });
  }

  // --- Relative jumps and calls --------------------------------------------------------------------
  if ((opcode & 0xf000) === 0xc000 || (opcode & 0xf000) === 0xd000) {
    const k = signed(opcode & 0x0fff, 12);
    const target = address + 2 + k * 2;
    return one((opcode & 0xf000) === 0xc000 ? 'rjmp' : 'rcall', formatRelative(k, target), { target });
  }

  // --- Conditional branches --------------------------------------------------------------------
  if ((opcode & 0xf800) === 0xf000 || (opcode & 0xf800) === 0xf400) {
    const k = signed((opcode >> 3) & 0x7f, 7);
    const target = address + 2 + k * 2;
    const set = (opcode & 0x0400) === 0;
    const mnemonic = (set ? BRBS_NAMES : BRBC_NAMES)[b3]!;
    return one(mnemonic, formatRelative(k, target), { target });
  }

  // --- Bit transfer and skip-on-bit ----------------------------------------------------------------
  if ((opcode & 0xfe08) === 0xf800) return one('bld', `r${d5}, ${b3}`);
  if ((opcode & 0xfe08) === 0xfa00) return one('bst', `r${d5}, ${b3}`);
  if ((opcode & 0xfe08) === 0xfc00) return one('sbrc', `r${d5}, ${b3}`);
  if ((opcode & 0xfe08) === 0xfe00) return one('sbrs', `r${d5}, ${b3}`);

  // Unknown. An honest hex word beats a confidently wrong mnemonic.
  return one('.word', hex(opcode, 4));
}

/** The register field for a store, which sits where `d` sits for a load. */
function r5AsStore(opcode: number): number {
  return (opcode >> 4) & 0x1f;
}

/** Branch targets read better as `.+6` with the absolute address alongside. */
function formatRelative(k: number, target: number): string {
  const offset = k * 2;
  return `.${offset >= 0 ? '+' : ''}${offset}`.concat(`  ; ${hex(target, 4)}`);
}

export interface DisassembleOptions {
  /** First byte address to decode. */
  readonly from?: number;
  /** Last byte address, exclusive. */
  readonly to?: number;
}

/**
 * Disassemble a span of flash.
 *
 * Decoding is linear from `from`, which is what objdump does and what a listing needs. It can drift
 * out of phase if it starts inside a 32-bit instruction, so callers wanting a listing around the
 * program counter should start from a known-aligned point such as 0.
 */
export function disassemble(progMem: Uint16Array, options: DisassembleOptions = {}): DisasmLine[] {
  const fromWord = Math.max(0, Math.floor((options.from ?? 0) / 2));
  const toWord = Math.min(progMem.length, Math.ceil((options.to ?? progMem.length * 2) / 2));

  const lines: DisasmLine[] = [];
  let word = fromWord;
  while (word < toWord) {
    const line = decode(progMem[word]!, progMem[word + 1] ?? 0, word);
    lines.push(line);
    word += line.size / 2;
  }
  return lines;
}

/** Index a listing by byte address, so the debugger can find the current line in one lookup. */
export function indexByAddress(lines: readonly DisasmLine[]): Map<number, number> {
  const index = new Map<number, number>();
  lines.forEach((line, i) => index.set(line.address, i));
  return index;
}
