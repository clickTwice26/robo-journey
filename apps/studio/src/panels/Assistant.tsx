/**
 * The assistant panel.
 *
 * Asks about the circuit that is on screen, and sends it with every question. The workspace is not
 * remembered between questions on purpose: the circuit changes between them, and an answer about
 * the circuit as it was two edits ago is worse than no answer.
 *
 * Cost is shown before and after, never hidden. Someone spending a metered resource should know
 * the balance before they ask and what the last question took afterwards -- a feature that spends
 * money quietly is one nobody can reason about.
 */
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import TokenIcon from '@mui/icons-material/Toll';
import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AuthError,
  InsufficientCreditsError,
  askAssistant,
  assistantConfigured,
  fetchCredits,
  type CreditBalance,
} from '../auth.ts';
import { useStudio } from '../store.ts';

interface Turn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** What this answer cost. Absent on questions and on the answer being waited for. */
  readonly credits?: number;
}

/** Enough to follow a thread without paying to resend an essay with every question. */
const HISTORY_SENT = 12;

/**
 * Questions worth suggesting.
 *
 * An empty chat box is a worse prompt than a bad question. These are the three things people
 * actually open an assistant to ask about a circuit they cannot get working.
 */
const OPENERS = [
  'What is wrong with this circuit?',
  'Why is the simulation reporting that fault?',
  'What should I check first?',
];

/**
 * An answer, rendered as the markdown it is.
 *
 * The model writes fenced code, inline code and lists because that is what it has been asked for,
 * and showing the fences and backticks as literal characters made every answer containing a sketch
 * fragment hard to read -- which is most of the useful ones.
 *
 * Raw HTML is not enabled, which is the default and worth keeping: this is model output rendered
 * into the page, and the one thing it must never be able to do is bring its own markup.
 */
function Answer({ text }: { text: string }) {
  return (
    <Box
      sx={{
        fontSize: 13,
        lineHeight: 1.6,
        wordBreak: 'break-word',
        '& p': { my: 0.75 },
        '& p:first-of-type': { mt: 0 },
        '& p:last-child': { mb: 0 },
        '& ul, & ol': { my: 0.75, pl: 2.5 },
        '& li': { mb: 0.25 },
        '& h1, & h2, & h3, & h4': { fontSize: 13, fontWeight: 700, mt: 1.5, mb: 0.5 },
        '& a': { color: 'primary.main' },
        // Inline code sits inside a sentence, so it takes a tint and no border -- a boxed span
        // mid-paragraph breaks the line rhythm badly at this size.
        '& code': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.92em',
          bgcolor: 'action.hover',
          px: 0.5,
          py: 0.15,
          borderRadius: 0.5,
        },
        // A block is a block: its own frame, and its own scrollbar rather than forcing the whole
        // panel sideways when a line of C++ is long.
        '& pre': {
          my: 1,
          p: 1.25,
          bgcolor: 'action.hover',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          overflowX: 'auto',
        },
        '& pre code': { bgcolor: 'transparent', p: 0, fontSize: 12, lineHeight: 1.5 },
        '& table': { borderCollapse: 'collapse', my: 1, fontSize: 12 },
        '& th, & td': { border: 1, borderColor: 'divider', px: 0.75, py: 0.4 },
        '& blockquote': {
          my: 1,
          pl: 1.25,
          borderLeft: 3,
          borderColor: 'divider',
          color: 'text.secondary',
        },
      }}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </Box>
  );
}

export function AssistantPanel() {
  const project = useStudio((state) => state.project);
  const snapshot = useStudio((state) => state.snapshot);
  const hex = useStudio((state) => state.hex);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void assistantConfigured().then(setConfigured).catch(() => setConfigured(false));
    void fetchCredits()
      .then((credits) => setBalance(credits.balance))
      .catch(() => undefined);
  }, []);

  // Follows the conversation down as it grows, which is the one bit of chat behaviour that is
  // strange by its absence.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, busy]);

  const send = useCallback(
    async (text: string) => {
      const asked = text.trim();
      if (!asked || busy) return;

      setBusy(true);
      setError(null);
      setQuestion('');
      const before = [...turns, { role: 'user' as const, content: asked }];
      setTurns(before);

      try {
        const reply = await askAssistant(
          asked,
          {
            project,
            faults: snapshot.faults,
            simulation: {
              running: snapshot.running,
              seconds: snapshot.time,
              compiled: Boolean(hex),
            },
            voltages: snapshot.voltages,
          },
          before.slice(-HISTORY_SENT).map(({ role, content }) => ({ role, content })),
        );

        setTurns([...before, { role: 'assistant', content: reply.answer, credits: reply.credits }]);
        setBalance(reply.balance);
      } catch (caught) {
        // The question stays on screen with the failure beneath it, rather than vanishing: retyping
        // a question because the answer failed is a small insult.
        setError(
          caught instanceof InsufficientCreditsError
            ? `${caught.message} Nothing was charged.`
            : caught instanceof AuthError
              ? caught.message
              : (caught as Error).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, hex, project, snapshot, turns],
  );

  if (configured === false) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="info">
          The assistant is not configured on this server. Set <code>GEMINI_API_KEY</code> in the
          service environment and restart it.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 1.5, py: 1, alignItems: 'center', flexWrap: 'wrap', gap: 1 }}
      >
        <AutoAwesomeIcon fontSize="small" color="primary" />
        <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>
          Asks about the circuit on screen
        </Typography>
        {balance && (
          <Tooltip title="Credits left. Each question costs a few, depending on how long the answer is.">
            <Chip
              size="small"
              variant="outlined"
              icon={<TokenIcon />}
              label={balance.available.toLocaleString()}
              color={balance.available < 20 ? 'warning' : 'default'}
            />
          </Tooltip>
        )}
      </Stack>
      <Divider />

      <Box sx={{ flex: 1, overflow: 'auto', px: 1.5, py: 1 }}>
        {turns.length === 0 && !busy && (
          <Stack spacing={1} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              It can see your parts, how they are wired, the sketch, and whatever the simulator is
              currently reporting.
            </Typography>
            {OPENERS.map((opener) => (
              <Button
                key={opener}
                size="small"
                variant="outlined"
                sx={{ justifyContent: 'flex-start', textTransform: 'none' }}
                onClick={() => void send(opener)}
              >
                {opener}
              </Button>
            ))}
          </Stack>
        )}

        {turns.map((turn, index) => (
          <Box
            key={index}
            sx={{
              mb: 1.5,
              px: 1.25,
              py: 1,
              borderRadius: 1,
              bgcolor: turn.role === 'user' ? 'action.hover' : 'transparent',
              border: turn.role === 'assistant' ? 1 : 0,
              borderColor: 'divider',
            }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}
            >
              {turn.role === 'user' ? 'You' : 'Assistant'}
              {turn.credits !== undefined && ` · ${turn.credits} credit${turn.credits === 1 ? '' : 's'}`}
            </Typography>
            {turn.role === 'user' ? (
              <Typography
                variant="body2"
                sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, wordBreak: 'break-word' }}
              >
                {turn.content}
              </Typography>
            ) : (
              <Answer text={turn.content} />
            )}
          </Box>
        ))}

        {busy && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1.25, py: 1 }}>
            <CircularProgress size={14} />
            <Typography variant="caption" color="text.secondary">
              Reading your circuit…
            </Typography>
          </Stack>
        )}

        {error && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}

        <div ref={endRef} />
      </Box>

      <Divider />
      <Box
        component="form"
        sx={{ p: 1, display: 'flex', gap: 1 }}
        onSubmit={(event) => {
          event.preventDefault();
          void send(question);
        }}
      >
        <TextField
          size="small"
          fullWidth
          multiline
          maxRows={4}
          placeholder="Ask about this circuit…"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, shift-enter breaks the line. The other way round in a panel this size
            // means every question needs a mouse.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(question);
            }
          }}
          disabled={busy}
        />
        <Button type="submit" variant="contained" disabled={busy || !question.trim()} sx={{ minWidth: 44 }}>
          <SendIcon fontSize="small" />
        </Button>
      </Box>
    </Box>
  );
}
