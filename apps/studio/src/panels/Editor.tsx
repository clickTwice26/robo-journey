/**
 * Sketch editor.
 *
 * Monaco is VS Code's editor, so C++ highlighting and the marker API come for free -- which means
 * an avr-gcc diagnostic becomes a real inline squiggle on the real line, with no custom UI.
 */
import Editor, { type Monaco } from '@monaco-editor/react';
import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { editorTheme } from '../theme.ts';
import { useEffect, useRef } from 'react';
import type { editor } from 'monaco-editor';
import { useStudio } from '../store.ts';

const MAIN_FILE = 'sketch.ino';

export function EditorPanel() {
  const mode = useTheme().palette.mode;
  const project = useStudio((s) => s.project);
  const diagnostics = useStudio((s) => s.diagnostics);
  const setSketch = useStudio((s) => s.setSketch);

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  const contents = project.sketch.find((f) => f.name === MAIN_FILE)?.contents ?? '';

  // Compiler diagnostics become editor markers. Re-applied whenever a compile finishes.
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;

    monaco.editor.setModelMarkers(
      model,
      'arduino-cli',
      diagnostics.map((d) => ({
        startLineNumber: d.line,
        endLineNumber: d.line,
        startColumn: d.column ?? 1,
        // Highlight to end of line when the compiler gave no column span.
        endColumn: d.column ? d.column + 1 : model.getLineMaxColumn(d.line),
        message: d.message,
        severity:
          d.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : d.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      })),
    );
  }, [diagnostics]);

  return (
    <Box sx={{ height: '100%', width: '100%' }}>
      <Editor
        height="100%"
        defaultLanguage="cpp"
        theme={editorTheme(mode)}
        value={contents}
        onChange={(value) => setSketch(MAIN_FILE, value ?? '')}
        onMount={(instance, monaco) => {
          editorRef.current = instance;
          monacoRef.current = monaco;
        }}
        options={{
          fontSize: 13,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
          automaticLayout: true,
          renderWhitespace: 'selection',
        }}
      />
    </Box>
  );
}
