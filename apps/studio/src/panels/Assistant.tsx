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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import TokenIcon from '@mui/icons-material/Toll';
import { useCallback, useEffect, useRef, useState } from 'react';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubble';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { AgentPlanCard, type PlanState } from './AgentPlanCard.tsx';
import { checkPlan, type CheckedPlan } from '../agent/plan.ts';
import { runPlan } from '../agent/run.ts';
import type { Project } from '@robo-journey/parts';

/** Ask answers; Agent proposes edits. */
type AssistantMode = 'ask' | 'agent';
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
 * Openers for Agent mode.
 *
 * Phrased as instructions rather than questions, because that is the difference between the two
 * modes and the suggestions are where somebody works out which one they are in.
 */
const AGENT_OPENERS = [
  'Fix whatever the Problems panel is reporting',
  'Add a resistor in series with the LED',
  'Rewrite the sketch to print the reading over serial',
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
  const [mode, setMode] = useState<AssistantMode>('ask');
  // Keyed by the index of the turn that proposed it, so a plan stays with its own message as the
  // conversation grows.
  const [plans, setPlans] = useState<Record<number, { plan: CheckedPlan; state: PlanState }>>({});
  // The project as it stood before a plan ran, so "Undo all" is one step rather than N.
  const before = useRef<Record<number, Project>>({});
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
      const history = [...turns, { role: 'user' as const, content: asked }];
      setTurns(history);

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
          history.slice(-HISTORY_SENT).map(({ role, content }) => ({ role, content })),
          mode,
        );

        const turnIndex = history.length;
        setTurns([...history, { role: 'assistant', content: reply.answer, credits: reply.credits }]);
        setBalance(reply.balance);

        // Checked against the real registry and the real project before it is shown, so a step
        // that cannot run is visible as such rather than discovered halfway through applying.
        if (reply.plan && reply.plan.actions.length > 0) {
          setPlans((current) => ({
            ...current,
            [turnIndex]: { plan: checkPlan(reply.plan!.actions, project), state: { phase: 'proposed' } },
          }));
        }
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
    [busy, hex, mode, project, snapshot, turns],
  );

  /** Run a plan, marking each step off as it goes. */
  const apply = useCallback(async (index: number) => {
    const entry = plans[index];
    if (!entry || entry.state.phase !== 'proposed') return;

    // Snapshot first. Undoing an agent run one action at a time is not undo, it is archaeology.
    before.current[index] = useStudio.getState().project;
    setPlans((current) => ({ ...current, [index]: { ...entry, state: { phase: 'running', at: 0 } } }));

    const count = await runPlan(entry.plan.runnable, (at) =>
      setPlans((current) => ({ ...current, [index]: { ...entry, state: { phase: 'running', at } } })),
    );

    setPlans((current) => ({ ...current, [index]: { ...entry, state: { phase: 'applied', count } } }));
  }, [plans]);

  const undo = useCallback((index: number) => {
    const snapshot_ = before.current[index];
    if (!snapshot_) return;
    useStudio.getState().loadProject(snapshot_);
    const entry = plans[index];
    if (entry) {
      setPlans((current) => ({ ...current, [index]: { ...entry, state: { phase: 'proposed' } } }));
    }
  }, [plans]);

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
        {/* Ask answers; Agent proposes edits and applies them once you say so. The switch is here
            rather than in a menu because which of the two you get is the single most consequential
            thing about the message you are about to send. */}
        <ToggleButtonGroup
          exclusive
          size="small"
          value={mode}
          onChange={(_event: unknown, next: string | null) => {
            if (next) setMode(next as AssistantMode);
          }}
          sx={{ flex: 1 }}
        >
          <ToggleButton value="ask" sx={{ py: 0.1, px: 1.25, textTransform: 'none' }}>
            <ChatBubbleOutlineIcon sx={{ fontSize: 14, mr: 0.75 }} />
            Ask
          </ToggleButton>
          <ToggleButton value="agent" sx={{ py: 0.1, px: 1.25, textTransform: 'none' }}>
            <AutoFixHighIcon sx={{ fontSize: 14, mr: 0.75 }} />
            Agent
          </ToggleButton>
        </ToggleButtonGroup>
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
              {mode === 'ask'
                ? 'It can see your parts, how they are wired, the sketch, and whatever the simulator is currently reporting.'
                : 'It can see the same things, and it can change them — place parts, wire them, rewrite the sketch. It proposes the changes and nothing happens until you apply them.'}
            </Typography>
            {(mode === 'ask' ? OPENERS : AGENT_OPENERS).map((opener) => (
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
              <>
                <Answer text={turn.content} />
                {plans[index] && (
                  <AgentPlanCard
                    plan={plans[index]!.plan}
                    state={plans[index]!.state}
                    onApply={() => void apply(index)}
                    onDiscard={() =>
                      setPlans((current) => ({
                        ...current,
                        [index]: { ...current[index]!, state: { phase: 'discarded' } },
                      }))
                    }
                    onUndo={() => undo(index)}
                  />
                )}
              </>
            )}
          </Box>
        ))}

        {busy && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1.25, py: 1 }}>
            <CircularProgress size={14} />
            <Typography variant="caption" color="text.secondary">
              {mode === 'agent' ? 'Working out what to change…' : 'Reading your circuit…'}
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
          placeholder={mode === 'agent' ? 'Tell it what to change…' : 'Ask about this circuit…'}
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
