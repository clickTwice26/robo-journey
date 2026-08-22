/**
 * Everything the app can do, one keystroke away.
 *
 * A menu bar is a good map and a bad index: you have to know which of seven menus a thing lives
 * under before you can reach it. This is the other half -- type what you want, press enter.
 *
 * The commands are *derived from the menu bar* rather than listed again here. A second list would
 * be wrong within a week: someone adds a menu item, forgets the palette, and the palette quietly
 * becomes a map of what the app used to do. Anything with a label and an action is a command, so
 * new menu items appear here for free.
 *
 * Parts are folded in on top, because "add an LED" is the single most common thing anyone wants
 * and hunting for it in a list of sixty is exactly what this is for.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Chip,
  Dialog,
  InputBase,
  List,
  ListItemButton,
  ListSubheader,
  Stack,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import { allParts } from '@robo-journey/parts';
import { useStudio } from '../store.ts';

export interface Command {
  readonly group: string;
  readonly label: string;
  readonly icon?: React.ReactNode;
  readonly hint?: string;
  readonly secondary?: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

/**
 * Rank a command against what has been typed.
 *
 * Subsequence rather than substring, so "bru" finds "Build & Run" -- which is how every palette
 * anybody has used behaves, and the reason typing three letters is enough. A run of adjacent
 * matches scores higher than the same letters scattered, so exact prefixes rise to the top without
 * needing a separate case for them.
 *
 * Exported for its own test. Ranking is the kind of thing that looks right in a screenshot and is
 * wrong on the third query anybody tries.
 */
export function score(haystack: string, needle: string): number {
  if (needle === '') return 1;
  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();

  let at = 0;
  let points = 0;
  let streak = 0;
  for (const character of query) {
    const found = text.indexOf(character, at);
    if (found < 0) return 0;
    // A letter starting a word is worth more than one in the middle: "bar" should prefer
    // "Build & Run" over "Clear all breakpoints", which also contains b, a and r in order.
    const boundary = found === 0 || /[\s&(–—-]/.test(text[found - 1] ?? '');
    streak = found === at ? streak + 1 : 0;
    points += 1 + streak + (boundary ? 3 : 0);
    at = found + 1;
  }
  // Shorter labels win ties, so "Compile" beats "Clear all breakpoints" for "comp".
  return points + 10 / text.length;
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: readonly Command[];
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const setMode = useStudio((s) => s.setMode);

  // Every part, as "Add …". Built here rather than passed in because nothing else needs it, and
  // the registry is the only thing that knows what has been added from a datasheet this session.
  const partCommands = useMemo<Command[]>(
    () =>
      open
        ? allParts().map((part) => ({
            group: 'Add a part',
            label: `Add ${part.label}`,
            icon: <AddIcon fontSize="small" />,
            secondary: part.type,
            run: () => setMode({ kind: 'place', partType: part.type }),
          }))
        : [],
    [open, setMode],
  );

  const matches = useMemo(() => {
    const all = [...commands, ...partCommands];
    return all
      .map((command) => ({
        command,
        // The group is part of the haystack, so "view zoom" and "simulate reset" both work.
        rank: score(`${command.label} ${command.group}`, query.trim()),
      }))
      .filter((entry) => entry.rank > 0 && !entry.command.disabled)
      .sort((a, b) => b.rank - a.rank)
      // Enough to scroll, not so many that the list is the problem it was meant to solve.
      .slice(0, 40)
      .map((entry) => entry.command);
  }, [commands, partCommands, query]);

  // Reset between openings: reopening onto someone else's half-typed query is disorienting.
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
    }
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, matches]);

  const runAt = (index: number) => {
    const command = matches[index];
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => (matches.length === 0 ? 0 : (c + 1) % matches.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => (matches.length === 0 ? 0 : (c - 1 + matches.length) % matches.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runAt(cursor);
    }
  };

  // Headings are emitted as the group changes down the sorted list rather than by bucketing, so
  // the best match stays first whatever menu it came from.
  let lastGroup = '';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      // Near the top, where every palette puts it: the eye is already there from the menu bar.
      slotProps={{ paper: { sx: { position: 'fixed', top: 80, m: 0, borderRadius: 2 } } }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider' }}
      >
        <SearchIcon sx={{ color: 'text.disabled' }} />
        <InputBase
          autoFocus
          fullWidth
          placeholder="Search commands and parts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          sx={{ fontSize: 15 }}
        />
        <Chip label="Esc" size="small" variant="outlined" sx={{ height: 20, fontSize: 11 }} />
      </Stack>

      <List ref={listRef} dense sx={{ maxHeight: 380, overflow: 'auto', py: 0 }}>
        {matches.length === 0 && (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              Nothing matches “{query}”.
            </Typography>
          </Box>
        )}

        {matches.map((command, index) => {
          const heading = command.group !== lastGroup ? command.group : null;
          lastGroup = command.group;
          return (
            <Box key={`${command.group}:${command.label}`}>
              {heading && (
                <ListSubheader sx={{ lineHeight: '28px', fontSize: 11, letterSpacing: 0.6 }}>
                  {heading.toUpperCase()}
                </ListSubheader>
              )}
              <ListItemButton
                data-active={index === cursor}
                selected={index === cursor}
                onMouseMove={() => setCursor(index)}
                onClick={() => runAt(index)}
                sx={{ px: 2, py: 0.75 }}
              >
                <Box sx={{ width: 28, display: 'flex', color: 'text.secondary' }}>
                  {command.icon}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap>
                    {command.label}
                  </Typography>
                  {command.secondary && (
                    <Typography variant="caption" color="text.disabled" noWrap>
                      {command.secondary}
                    </Typography>
                  )}
                </Box>
                {command.hint && (
                  <Typography variant="caption" color="text.disabled" sx={{ ml: 2 }}>
                    {command.hint}
                  </Typography>
                )}
              </ListItemButton>
            </Box>
          );
        })}
      </List>
    </Dialog>
  );
}
