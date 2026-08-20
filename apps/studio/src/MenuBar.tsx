/**
 * Application menu bar.
 *
 * Laid out the way a desktop tool is: an identity, then File / Edit / View / Simulate / Help, then
 * the action toolbar and the live readouts on a second row. Everything here does something -- a
 * menu of greyed-out placeholders is worse than no menu, because it teaches people not to look.
 *
 * Shortcuts use the platform's own modifier (Cmd on macOS, Ctrl elsewhere) and are shown next to
 * their items, since a menu is also how people discover them.
 */
import {
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  IconButton,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import BuildIcon from '@mui/icons-material/Build';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import CollectionsBookmarkIcon from '@mui/icons-material/CollectionsBookmark';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import SettingsBrightnessIcon from '@mui/icons-material/SettingsBrightness';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RedoIcon from '@mui/icons-material/Redo';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SaveIcon from '@mui/icons-material/Save';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import UndoIcon from '@mui/icons-material/Undo';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import LogoutIcon from '@mui/icons-material/Logout';
import { emptyProject } from '@robo-journey/parts';
import type { ThemeControl } from './useThemeMode.ts';
import type { ThemePreference } from './theme.ts';
import { compileSketch, CompileUnavailableError } from './api.ts';
import { createProject, saveProject } from './auth.ts';
import type { AccessGate } from './useAccess.ts';
import { formatDuration } from './panels/AccessGate.tsx';
import { downloadProject } from './projectFile.ts';
import { useStudio } from './store.ts';
import type { SimulationController } from './sim/useSimulation.ts';

/** Panels the View menu can show. Ids match those registered in the dockview layout. */
export const PANELS = [
  { id: 'workspace', title: 'Workspace' },
  { id: 'palette', title: 'Parts' },
  { id: 'properties', title: 'Properties' },
  { id: 'editor', title: 'sketch.ino' },
  { id: 'problems', title: 'Problems' },
  { id: 'serial', title: 'Serial Monitor' },
  { id: 'scope', title: 'Scope' },
  { id: 'inspector', title: 'MCU' },
  { id: 'disassembly', title: 'Disassembly' },
  { id: 'assistant', title: 'Assistant' },
] as const;

export interface MenuBarActions {
  /** Bring a panel forward, adding it back if it was closed. */
  showPanel(id: string): void;
  /** Restore the default arrangement. */
  resetLayout(): void;
  /** Whether a panel is currently open. */
  isPanelOpen(id: string): boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
const shortcut = (key: string): string => `${MOD}${key}`;

/**
 * Bindings the browser owns, and which this application therefore does not take.
 *
 * Reload is the one that matters. Taking Ctrl+R for "build and run" means someone who wants to
 * reload the page instead recompiles their sketch, and there is no way for them to find out why
 * short of guessing. The same goes for the zoom trio: a canvas that intercepts Ctrl+plus leaves
 * people unable to make the interface itself bigger.
 *
 * Reserved by every major browser on both platforms:
 *   R (reload) · T, W, N (tabs and windows) · L (address bar) · D (bookmark) · P (print)
 *   F, G (find) · +, -, 0 (page zoom) · 1-9 (tab switching) · Q, H, M (macOS system)
 *
 * S and O are taken deliberately. Both have a browser meaning -- save page, open file -- but every
 * editor on the web overrides them and people expect that; nobody reaches for Ctrl+S in a document
 * wanting a copy of the HTML.
 */

/**
 * Whether a keystroke belongs to whatever is being typed into.
 *
 * Single-key bindings are only safe with this: `1` has to mean "fit the circuit" on the canvas and
 * the digit one inside the sketch. Monaco is checked by class because it is not a plain input.
 */
function isTyping(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  if (active.closest('.monaco-editor')) return true;
  return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT';
}

interface Props {
  sim: SimulationController;
  actions: MenuBarActions | null;
  onOpenDatasheet(): void;
  onOpenCloudProjects(): void;
  onOpenLibrary(): void;
  theme: ThemeControl;
  /** The seat this session is running on, for the countdown and for signing out. */
  gate: AccessGate;
}

export function MenuBar({
  sim,
  actions,
  onOpenDatasheet,
  onOpenCloudProjects,
  onOpenLibrary,
  theme,
  gate,
}: Props) {
  const project = useStudio((s) => s.project);
  const snapshot = useStudio((s) => s.snapshot);
  const soundOn = useStudio((s) => s.soundOn);
  const toggleSound = useStudio((s) => s.toggleSound);
  const compileStatus = useStudio((s) => s.compileStatus);
  const hex = useStudio((s) => s.hex);
  const selection = useStudio((s) => s.selection);
  const past = useStudio((s) => s.past);
  const future = useStudio((s) => s.future);
  const user = useStudio((s) => s.user);
  const canvasControls = useStudio((s) => s.canvasControls);
  const cloudProjectId = useStudio((s) => s.cloudProjectId);
  const syncedAt = useStudio((s) => s.syncedAt);
  const syncError = useStudio((s) => s.syncError);

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const anchors = useRef<Record<string, HTMLElement | null>>({});
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => setOpenMenu(null), []);

  /**
   * Click-away and Escape, since the backdrop no longer does it.
   *
   * Clicks inside a menu paper or on a menu title are ignored: the first is a selection, the
   * second is a switch, and closing on either would make the bar unusable.
   */
  useEffect(() => {
    if (!openMenu) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.MuiMenu-paper') || target.closest('[data-menubar-title]')) return;
      setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  // --- Actions ---------------------------------------------------------------------------------

  const build = useCallback(async (): Promise<boolean> => {
    const store = useStudio.getState();
    store.setCompile('compiling', [], null);
    try {
      const result = await compileSketch(store.project.sketch);
      store.setCompile(result.ok ? 'ok' : 'error', result.diagnostics, result.hex ?? null);
      if (result.ok && result.hex) {
        sim.load(store.project, result.hex);
        return true;
      }
      return false;
    } catch (caught) {
      store.setBuildError(
        caught instanceof CompileUnavailableError ? caught.message : (caught as Error).message,
      );
      return false;
    }
  }, [sim]);

  const buildAndRun = useCallback(async () => {
    if (await build()) sim.start();
  }, [build, sim]);

  const save = useCallback(() => downloadProject(useStudio.getState().project), []);

  /**
   * Save to the account.
   *
   * Creates a project the first time and updates it thereafter, so repeated saves do not litter
   * the account with copies of the same circuit.
   */
  const saveToAccount = useCallback(async () => {
    const store = useStudio.getState();
    // Unreachable in practice -- the workspace only mounts for a signed-in account -- but the
    // store's copy of the user is a mirror, so this stays rather than assuming it.
    if (!store.user) return;
    try {
      if (store.cloudProjectId) {
        await saveProject(store.cloudProjectId, store.project.name, store.project);
      } else {
        const created = await createProject(store.project.name, store.project);
        store.setCloudProject(created.id);
      }
      store.setSyncState(new Date(), null);
    } catch (caught) {
      store.setSyncState(store.syncedAt, (caught as Error).message);
    }
  }, []);

  // Signing out gives the seat back as well as ending the session, so whoever is waiting gets it
  // straight away rather than after the heartbeat grace expires.
  const signOut = useCallback(() => void gate.signOut(), [gate]);

  const newProject = useCallback(() => {
    useStudio.getState().loadProject(emptyProject('Untitled'));
    useStudio.getState().setCompile('idle', [], null);
  }, []);

  const unplugSelection = useCallback(() => {
    const store = useStudio.getState();
    if (!store.selection) return;
    for (const wire of store.project.wires) {
      if (wire.from.startsWith(`${store.selection}:`) || wire.to.startsWith(`${store.selection}:`)) {
        store.removeWire(wire.id);
      }
    }
  }, []);

  // --- Keyboard shortcuts ------------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = isMac ? event.metaKey : event.ctrlKey;

      // Unmodified keys, which only apply when nothing is being typed into.
      if (!mod && !event.altKey) {
        if (isTyping()) return;
        // Figma's binding for the same action, and free of any browser meaning -- unlike the
        // Ctrl+0 that would be the obvious choice and is page zoom everywhere.
        if (event.key === '1') {
          event.preventDefault();
          useStudio.getState().canvasControls?.fit();
        }
        // Every canvas tool turns the selection with R, and there is nothing else it could mean
        // while the workspace has focus.
        if (event.key.toLowerCase() === 'r') {
          const store = useStudio.getState();
          const selected = store.selection;
          if (!selected) return;
          const part = store.project.parts.find((p) => p.id === selected);
          if (!part) return;
          event.preventDefault();
          // Shift turns the other way, which is what saves three presses to undo one.
          store.rotatePart(selected, part.rotation + (event.shiftKey ? -90 : 90));
        }
        return;
      }
      if (!mod) return;

      // Monaco owns undo inside the editor; intercepting it there would break text editing.
      const inEditor =
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest('.monaco-editor') !== null;

      switch (event.key.toLowerCase()) {
        case 's':
          event.preventDefault();
          // Shift saves to the account; plain Save downloads a file, as every editor does.
          if (event.shiftKey) void saveToAccount();
          else save();
          break;
        case 'o':
          event.preventDefault();
          onOpenCloudProjects();
          break;
        case 'b':
          event.preventDefault();
          void build();
          break;
        case 'enter':
          // Not R. Ctrl+R is reload in every browser, and taking it means someone who wants to
          // reload recompiles their sketch instead with no way to work out why.
          event.preventDefault();
          void buildAndRun();
          break;
        case 'z':
          if (inEditor) return;
          event.preventDefault();
          if (event.shiftKey) useStudio.getState().redo();
          else useStudio.getState().undo();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save, onOpenCloudProjects, build, buildAndRun, saveToAccount]);

  // --- Menu definitions ----------------------------------------------------------------------------

  const menus = useMemo(
    () => [
      {
        id: 'file',
        label: 'File',
        items: [
          { label: 'New project', icon: <InsertDriveFileIcon fontSize="small" />, onClick: newProject },
          {
            // One dialog for both sources. Splitting them -- a file picker here, a saved list in
            // the account menu -- makes someone decide where their circuit is before they can go
            // looking for it, and they frequently do not remember.
            label: 'Open project…',
            icon: <FolderOpenIcon fontSize="small" />,
            secondary: 'From a file or from your account',
            hint: shortcut('O'),
            onClick: onOpenCloudProjects,
          },
          { label: 'Save project', icon: <SaveIcon fontSize="small" />, hint: shortcut('S'), onClick: save },
          { divider: true },
          {
            label: 'Library…',
            icon: <CollectionsBookmarkIcon fontSize="small" />,
            secondary: 'Prebuilt projects, grouped by what they show',
            onClick: onOpenLibrary,
          },
          { divider: true },
          {
            label: 'Add component from datasheet…',
            icon: <AutoAwesomeIcon fontSize="small" />,
            onClick: onOpenDatasheet,
          },
        ],
      },
      {
        id: 'edit',
        label: 'Edit',
        items: [
          { label: 'Undo', icon: <UndoIcon fontSize="small" />, hint: shortcut('Z'), disabled: past.length === 0, onClick: () => useStudio.getState().undo() },
          { label: 'Redo', icon: <RedoIcon fontSize="small" />, hint: `${MOD}⇧Z`, disabled: future.length === 0, onClick: () => useStudio.getState().redo() },
          { divider: true },
          {
            label: 'Unplug selection',
            icon: <LinkOffIcon fontSize="small" />,
            secondary: 'Remove its wires, keep the part',
            disabled: !selection,
            onClick: unplugSelection,
          },
          {
            label: 'Delete selection',
            icon: <DeleteOutlineIcon fontSize="small" />,
            hint: 'Del',
            disabled: !selection,
            onClick: () => selection && useStudio.getState().removePart(selection),
          },
        ],
      },
      {
        id: 'view',
        label: 'View',
        items: [
          // The canvas zoom lived only as three floating buttons over the workspace. Anyone
          // looking for it in a menu -- which is where every other application keeps it -- found
          // a list of panels and nothing else.
          {
            label: 'Zoom in',
            icon: <ZoomInIcon fontSize="small" />,
            // No keyboard hint: the browser owns every plausible zoom binding, so this is the
            // button, the canvas controls, and the scroll wheel.
            disabled: !canvasControls,
            onClick: () => canvasControls?.zoomIn(),
          },
          {
            label: 'Zoom out',
            icon: <ZoomOutIcon fontSize="small" />,
            disabled: !canvasControls,
            onClick: () => canvasControls?.zoomOut(),
          },
          {
            label: 'Fit circuit to view',
            icon: <FitScreenIcon fontSize="small" />,
            hint: '1',
            disabled: !canvasControls,
            onClick: () => canvasControls?.fit(),
          },
          { divider: true },
          ...PANELS.map((panel) => ({
            label: panel.title,
            secondary: actions?.isPanelOpen(panel.id) ? 'open' : 'closed',
            onClick: () => actions?.showPanel(panel.id),
          })),
          { divider: true },
          // Three choices, not a toggle: "dark" and "whatever my system is doing" are different
          // answers, and a two-state switch silently turns the second into the first.
          ...(
            [
              { value: 'light', label: 'Light', icon: <LightModeIcon fontSize="small" /> },
              { value: 'dark', label: 'Dark', icon: <DarkModeIcon fontSize="small" /> },
              { value: 'system', label: 'Match system', icon: <SettingsBrightnessIcon fontSize="small" /> },
            ] as const
          ).map((option) => ({
            label: option.label,
            icon: option.icon,
            secondary:
              theme.preference === option.value
                ? option.value === 'system'
                  ? `in use · currently ${theme.mode}`
                  : 'in use'
                : undefined,
            onClick: () => theme.setPreference(option.value as ThemePreference),
          })),
          { divider: true },
          { label: 'Reset layout', icon: <RestartAltIcon fontSize="small" />, onClick: () => actions?.resetLayout() },
        ],
      },
      {
        id: 'simulate',
        label: 'Simulate',
        items: [
          { label: 'Compile', icon: <BuildIcon fontSize="small" />, hint: shortcut('B'), onClick: () => void build() },
          { label: 'Build & Run', icon: <PlayArrowIcon fontSize="small" />, hint: shortcut('↵'), onClick: () => void buildAndRun() },
          { label: snapshot.running ? 'Pause' : 'Run', icon: snapshot.running ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />, disabled: !hex, onClick: () => (snapshot.running ? sim.pause() : sim.start()) },
          { divider: true },
          { label: 'Step one instruction', icon: <SkipNextIcon fontSize="small" />, disabled: !hex, onClick: () => sim.stepInstruction() },
          { label: 'Step 10 ms', icon: <SkipNextIcon fontSize="small" />, disabled: !hex, onClick: () => sim.stepTime(0.01) },
          { label: 'Reset', icon: <RestartAltIcon fontSize="small" />, disabled: !hex, onClick: () => sim.reset() },
          { divider: true },
          { label: 'Clear all breakpoints', onClick: () => sim.clearBreakpoints() },
        ],
      },
      {
        id: 'account',
        label: user ? user.displayName : 'Account',
        items: user
          ? [
              {
                label: user.email,
                secondary: `Signed in since ${new Date(user.createdAt).toLocaleDateString()}`,
                icon: <AccountCircleIcon fontSize="small" />,
                onClick: close,
              },
              { divider: true },
              {
                label: 'Your projects…',
                icon: <CloudDoneIcon fontSize="small" />,
                onClick: onOpenCloudProjects,
              },
              {
                label: cloudProjectId ? 'Save to account' : 'Save to account as new',
                icon: <CloudUploadIcon fontSize="small" />,
                hint: `${MOD}⇧S`,
                onClick: () => void saveToAccount(),
              },
              { divider: true },
              {
                label: 'End session and sign out',
                icon: <LogoutIcon fontSize="small" />,
                secondary: 'Frees your seat. The wait before your next turn applies either way.',
                onClick: signOut,
              },
            ]
          : [],
      },
      {
        id: 'help',
        label: 'Help',
        items: [
          {
            label: 'robo-journey',
            secondary: 'Real firmware on an emulated ATmega328P, coupled to a real analog solver.',
            onClick: close,
          },
          {
            label: 'Keyboard shortcuts',
            secondary:
              `${shortcut('↵')} build & run · ${shortcut('B')} compile · ${shortcut('S')} save · ` +
              `${shortcut('O')} open · ${shortcut('Z')} undo · 1 fit · R rotate · Del remove`,
            onClick: close,
          },
        ],
      },
    ],
    [
      actions, build, buildAndRun, cloudProjectId, close, future.length, hex,
      canvasControls, newProject, onOpenCloudProjects, onOpenDatasheet, onOpenLibrary, past.length, save,
      saveToAccount, selection, signOut, sim, snapshot.running, theme, unplugSelection, user,
    ],
  );

  /**
   * ⚠️ The account menu is pulled OUT of the row and rendered on the right edge.
   * A person's own name is not a peer of File / Edit / View — it is the identity
   * this window is acting as, which is why every editor puts it opposite the
   * menus rather than in them. It keeps its dropdown; only its position moves.
   */
  const leftMenus = useMemo(() => menus.filter((menu) => menu.id !== 'account'), [menus]);
  const accountMenu = useMemo(() => menus.find((menu) => menu.id === 'account'), [menus]);

  /**
   * One menu-bar title and its dropdown.
   *
   * ⚠️ Extracted so the account menu can sit on the RIGHT edge while sharing this
   * exact behaviour. The hover-to-switch, the anchor bookkeeping and the
   * pointer-events dance below are subtle enough that a second hand-written copy
   * for one menu would drift the first time any of it was touched.
   */
  const renderMenu = (menu: (typeof menus)[number], align: 'left' | 'right' = 'left') => (
    <Box key={menu.id}>
      <Button
        size="small"
        color="inherit"
        data-menubar-title={menu.id}
        ref={(element) => {
          anchors.current[menu.id] = element;
        }}
        onClick={() => setOpenMenu((current) => (current === menu.id ? null : menu.id))}
        // Hovering another title while a menu is open switches to it, the way a real menu bar
        // behaves -- clicking each one is a needless extra step.
        onMouseEnter={() => setOpenMenu((current) => (current ? menu.id : current))}
        sx={{
          minWidth: 0,
          px: 1,
          py: 0.25,
          fontWeight: 400,
          bgcolor: openMenu === menu.id ? 'action.selected' : 'transparent',
        }}
      >
        {menu.label}
      </Button>

      <Menu
        anchorEl={anchors.current[menu.id]}
        open={openMenu === menu.id}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: align }}
        transformOrigin={{ vertical: 'top', horizontal: align }}
        // MUI menus are modal, and the backdrop sits above the menu bar -- so clicking or
        // hovering another title while one is open only dismisses it, which is not how a
        // menu bar behaves. Letting pointer events through the root (but not the paper)
        // restores click-to-switch and hover-to-switch; a window listener takes over the
        // click-away duty the backdrop was doing.
        hideBackdrop
        disableScrollLock
        slotProps={{
          root: { sx: { pointerEvents: 'none' } },
          paper: { sx: { pointerEvents: 'auto' } },
          list: { dense: true, sx: { minWidth: 260, maxWidth: 420 } },
        }}
      >
        {menu.items.map((item, index) =>
          'divider' in item && item.divider ? (
            <Divider key={`d${index}`} sx={{ my: 0.5 }} />
          ) : (
            <MenuItem
              key={item.label}
              disabled={'disabled' in item ? item.disabled : false}
              onClick={() => {
                close();
                item.onClick?.();
              }}
            >
              {'icon' in item && item.icon && <ListItemIcon>{item.icon}</ListItemIcon>}
              <ListItemText
                inset={!('icon' in item && item.icon)}
                primary={item.label}
                secondary={'secondary' in item ? item.secondary : undefined}
                slotProps={{
                  primary: { variant: 'body2' },
                  secondary: { variant: 'caption', sx: { whiteSpace: 'normal' } },
                }}
              />
              {'hint' in item && item.hint && (
                <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
                  {item.hint}
                </Typography>
              )}
            </MenuItem>
          ),
        )}
      </Menu>
    </Box>
  );

  return (
    <AppBar position="static" color="transparent" sx={{ borderBottom: 1, borderColor: 'divider' }}>
      {/* Row one: identity and menus. */}
      <Toolbar variant="dense" sx={{ minHeight: 32, gap: 0.25, px: 1 }}>
        <Typography
          variant="subtitle2"
          sx={{ fontWeight: 700, mr: 1.5, letterSpacing: 0.2, color: 'primary.light' }}
        >
          robo-journey
        </Typography>

        {leftMenus.map((menu) => renderMenu(menu))}

        <Box sx={{ flex: 1 }} />

        <SeatCountdown expiresAt={gate.access?.expiresAt ?? null} />
        <SyncStatus
          user={user}
          syncedAt={syncedAt}
          syncError={syncError}
          cloudProjectId={cloudProjectId}
        />
        <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 220, ml: 1 }}>
          {project.name}
        </Typography>

        {/*
          The signed-in account, at the far right. Right-aligned dropdown so it
          opens inward instead of off the edge of the window.
        */}
        <Divider orientation="vertical" flexItem sx={{ mx: 1, my: 0.5 }} />
        {accountMenu && renderMenu(accountMenu, 'right')}
      </Toolbar>

      <Divider />

      {/* Row two: the actions people reach for constantly, plus the live readouts. */}
      <Toolbar variant="dense" sx={{ minHeight: 40, gap: 0.75, px: 1 }}>
        <Button
          size="small"
          startIcon={compileStatus === 'compiling' ? <CircularProgress size={13} /> : <BuildIcon />}
          onClick={() => void build()}
          disabled={compileStatus === 'compiling'}
          variant="outlined"
        >
          Compile
        </Button>

        {snapshot.running ? (
          <Button size="small" startIcon={<PauseIcon />} onClick={sim.pause} variant="contained">
            Pause
          </Button>
        ) : (
          <Button
            size="small"
            startIcon={<PlayArrowIcon />}
            onClick={hex ? sim.start : () => void buildAndRun()}
            variant="contained"
            disabled={compileStatus === 'compiling'}
          >
            {hex ? 'Run' : 'Build & Run'}
          </Button>
        )}

        <Tooltip title="Advance 10 ms of simulated time">
          <span>
            <Button size="small" startIcon={<SkipNextIcon />} onClick={() => sim.stepTime(0.01)} disabled={!hex}>
              Step
            </Button>
          </span>
        </Tooltip>

        <Button size="small" startIcon={<RestartAltIcon />} onClick={sim.reset} disabled={!hex}>
          Reset
        </Button>

        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />

        {/* Only shown when there is something in the circuit that can make a noise, so the button
            answers "why is it silent" at exactly the moment anyone asks it. */}
        {snapshot.sounds.length > 0 || soundOn === false ? (
          <Tooltip title={soundOn ? 'Buzzers are audible' : 'Buzzers are muted'}>
            <IconButton
              size="small"
              onClick={toggleSound}
              color={soundOn && snapshot.sounds.length > 0 ? 'primary' : 'default'}
            >
              {soundOn ? <VolumeUpIcon fontSize="small" /> : <VolumeOffIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        ) : null}

        <Chip size="small" variant="outlined" label={`t = ${snapshot.time.toFixed(3)} s`} sx={{ fontVariantNumeric: 'tabular-nums' }} />
        <Chip size="small" variant="outlined" label={`${snapshot.cycles.toLocaleString()} cycles`} sx={{ fontVariantNumeric: 'tabular-nums' }} />
        <Tooltip title="Simulated time per wall-clock second. Below 1.0 means the circuit is too heavy to run live.">
          <Chip
            size="small"
            variant="outlined"
            color={snapshot.realtimeRatio >= 1 ? 'success' : snapshot.running ? 'warning' : 'default'}
            label={`${snapshot.realtimeRatio.toFixed(2)}x realtime`}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          />
        </Tooltip>

        <Box sx={{ flex: 1 }} />

        {/* The assistant is otherwise a tab behind the editor, which is a poor place for the one
            feature nobody knows is there. A button says it exists. */}
        <Tooltip title="Ask about the circuit on screen. It can see your parts, wiring, sketch and faults.">
          <Button
            size="small"
            startIcon={<AutoAwesomeIcon />}
            onClick={() => actions?.showPanel('assistant')}
            sx={{ mr: 1 }}
          >
            Ask AI
          </Button>
        </Tooltip>

        {snapshot.stoppedAt !== null && (
          <Chip size="small" color="warning" label={`stopped at 0x${snapshot.stoppedAt.toString(16).toUpperCase().padStart(4, '0')}`} />
        )}
        {snapshot.faults.length > 0 && (
          <Chip
            size="small"
            color={snapshot.faults.some((f) => f.severity === 'error') ? 'error' : 'warning'}
            label={`${snapshot.faults.length} problem${snapshot.faults.length === 1 ? '' : 's'}`}
          />
        )}
        {error && <Chip size="small" color="error" label={error} onDelete={() => setError(null)} />}
      </Toolbar>
    </AppBar>
  );
}

/**
 * How much of the hour is left.
 *
 * Present at all times rather than appearing near the end, because the whole point is that the
 * limit should never be a surprise: someone deciding whether to start a big change wants to know
 * they have forty minutes, not to be told at two.
 *
 * Colour carries the urgency -- amber under five minutes, red under one -- so it reads at a glance
 * without anyone having to parse the number.
 */
function SeatCountdown({ expiresAt }: { expiresAt: string | null }) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      setRemaining(null);
      return;
    }
    const at = new Date(expiresAt).getTime();
    const tick = () => setRemaining(Math.max(0, at - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (remaining === null) return null;

  const minutes = remaining / 60_000;
  const colour = minutes < 1 ? 'error' : minutes < 5 ? 'warning' : 'default';

  return (
    <Tooltip
      title={
        minutes < 5
          ? 'Your hour is nearly up. Save anything you want to keep — a wait follows before your next turn.'
          : 'Time left in this session. Ten people can use the simulator at once, an hour each.'
      }
    >
      <Chip
        size="small"
        variant="outlined"
        color={colour}
        icon={<AccessTimeIcon />}
        label={formatDuration(remaining)}
        sx={{ fontVariantNumeric: 'tabular-nums', mr: 1 }}
      />
    </Tooltip>
  );
}

/**
 * Where the document currently lives.
 *
 * Worth its own indicator because the answer changes what a refresh costs. Signed out, work is in
 * this browser only -- true and fine, but the user should know it rather than assume a cloud that
 * is not there.
 */
function SyncStatus({
  user,
  syncedAt,
  syncError,
  cloudProjectId,
}: {
  user: { displayName: string } | null | undefined;
  syncedAt: Date | null;
  syncError: string | null;
  cloudProjectId: string | null;
}) {
  if (user === undefined) return null;

  if (syncError) {
    return (
      <Tooltip title={syncError}>
        <Chip size="small" color="warning" icon={<CloudOffIcon />} label="not synced" variant="outlined" />
      </Tooltip>
    );
  }

  if (!user) {
    return (
      <Tooltip title="Saved in this browser. Sign in to sync across machines.">
        <Chip size="small" variant="outlined" icon={<CloudOffIcon />} label="local only" />
      </Tooltip>
    );
  }

  if (!cloudProjectId) {
    return (
      <Tooltip title="Signed in, but this circuit is not saved to your account yet.">
        <Chip size="small" variant="outlined" icon={<CloudOffIcon />} label="not in account" />
      </Tooltip>
    );
  }

  return (
    <Tooltip title={syncedAt ? `Last synced ${syncedAt.toLocaleTimeString()}` : 'Saved to your account'}>
      <Chip size="small" variant="outlined" color="success" icon={<CloudDoneIcon />} label="synced" />
    </Tooltip>
  );
}

/** Re-exported so the shell can render the same chevron in nested menus later. */
export { ChevronRightIcon };
