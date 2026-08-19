/**
 * Serial monitor.
 *
 * xterm.js is VS Code's terminal, so ANSI handling, scrollback and selection are solved. Bytes
 * arrive exactly as the USART transmitted them -- no line buffering, no re-encoding -- so a sketch
 * printing a partial line shows a partial line, as a real monitor does.
 */
import { Box } from '@mui/material';
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStudio } from '../store.ts';

export function SerialPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const serial = useStudio((s) => s.snapshot.serial);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#14161a', foreground: '#e6e9ef', cursor: '#4da3ff' },
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminal.writeln('\x1b[90m-- serial monitor, 9600 baud --\x1b[0m');
    terminalRef.current = terminal;

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  // The snapshot delivers whatever the USART sent since the last poll, then clears it.
  useEffect(() => {
    if (serial) terminalRef.current?.write(serial);
  }, [serial]);

  return <Box ref={containerRef} sx={{ height: '100%', width: '100%', p: 0.5 }} />;
}
