/**
 * A proposed set of edits, before and while they are applied.
 *
 * The agent never changes the workspace on its own. It proposes, this shows what it proposes in
 * the same terms a person would use -- "Add resistor as r2", "Wire uno1:D13 to r2:a" -- and
 * nothing happens until Apply. That is not ceremony: an agent that edited on reply would leave
 * somebody staring at a circuit that had changed while they were reading a chat message.
 *
 * Steps that cannot be carried out are shown struck through with the reason rather than dropped.
 * A quietly shorter plan is the worst outcome available here, because the user would believe the
 * whole of it had been done.
 */
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import BlockIcon from '@mui/icons-material/Block';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import UndoIcon from '@mui/icons-material/Undo';
import { describeAction } from '@robo-journey/parts';
import type { CheckedPlan } from '../agent/plan.ts';

export type PlanState =
  | { readonly phase: 'proposed' }
  | { readonly phase: 'running'; readonly at: number }
  | { readonly phase: 'applied'; readonly count: number }
  | { readonly phase: 'discarded' };

export function AgentPlanCard({
  plan,
  state,
  onApply,
  onDiscard,
  onUndo,
}: {
  plan: CheckedPlan;
  state: PlanState;
  onApply(): void;
  onDiscard(): void;
  onUndo(): void;
}) {
  const blocked = plan.steps.filter((s) => s.problem !== null).length;
  const runnable = plan.runnable.length;

  if (plan.steps.length === 0) {
    return null;
  }

  return (
    <Box
      sx={{
        mt: 1.5,
        border: 1,
        borderColor: state.phase === 'applied' ? 'success.main' : 'divider',
        borderRadius: 1.5,
        overflow: 'hidden',
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1,
          bgcolor: 'action.hover',
        }}
      >
        <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: '0.06em' }}>
          PROPOSED CHANGES
        </Typography>
        <Chip size="small" variant="outlined" label={`${runnable}`} sx={{ height: 18 }} />
        {blocked > 0 && (
          <Chip size="small" color="warning" variant="outlined" label={`${blocked} skipped`} sx={{ height: 18 }} />
        )}
      </Stack>

      <Stack sx={{ px: 1.5, py: 1 }} spacing={0.75}>
        {plan.steps.map((step, index) => {
          const running = state.phase === 'running' && state.at === index;
          const done =
            (state.phase === 'running' && state.at > index) || state.phase === 'applied';

          return (
            <Stack
              key={index}
              direction="row"
              sx={{ gap: 1, alignItems: 'flex-start', opacity: step.problem ? 0.6 : 1 }}
            >
              <Box sx={{ width: 18, pt: 0.25, flexShrink: 0, display: 'flex' }}>
                {step.problem ? (
                  <BlockIcon sx={{ fontSize: 15, color: 'warning.main' }} />
                ) : running ? (
                  <CircularProgress size={13} />
                ) : done ? (
                  <CheckCircleIcon sx={{ fontSize: 15, color: 'success.main' }} />
                ) : (
                  <Box
                    sx={{
                      width: 7,
                      height: 7,
                      mt: 0.6,
                      ml: 0.5,
                      borderRadius: '50%',
                      border: 1,
                      borderColor: 'text.disabled',
                    }}
                  />
                )}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 500,
                    textDecoration: step.problem ? 'line-through' : 'none',
                  }}
                >
                  {describeAction(step.action)}
                </Typography>
                <Typography variant="caption" color={step.problem ? 'warning.main' : 'text.secondary'}>
                  {step.problem ?? step.action.note}
                </Typography>
              </Box>
            </Stack>
          );
        })}
      </Stack>

      {blocked > 0 && state.phase === 'proposed' && (
        <Alert severity="warning" variant="outlined" sx={{ mx: 1.5, mb: 1, py: 0 }}>
          <Typography variant="caption">
            The struck-out steps refer to something that is not there and will not run.
          </Typography>
        </Alert>
      )}

      <Stack direction="row" sx={{ gap: 1, px: 1.5, pb: 1.5, pt: 0.5, alignItems: 'center' }}>
        {state.phase === 'proposed' && (
          <>
            <Button
              size="small"
              variant="contained"
              startIcon={<PlayArrowIcon />}
              onClick={onApply}
              disabled={runnable === 0}
            >
              Apply {runnable > 0 ? `${runnable} change${runnable === 1 ? '' : 's'}` : ''}
            </Button>
            <Button size="small" onClick={onDiscard}>
              Discard
            </Button>
          </>
        )}

        {state.phase === 'running' && (
          <Typography variant="caption" color="text.secondary">
            Applying step {state.at + 1} of {runnable}…
          </Typography>
        )}

        {state.phase === 'applied' && (
          <>
            <Typography variant="caption" color="success.main" sx={{ fontWeight: 600 }}>
              Applied {state.count} change{state.count === 1 ? '' : 's'}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button size="small" startIcon={<UndoIcon />} onClick={onUndo}>
              Undo all
            </Button>
          </>
        )}

        {state.phase === 'discarded' && (
          <Typography variant="caption" color="text.secondary">
            Discarded.
          </Typography>
        )}
      </Stack>
    </Box>
  );
}
