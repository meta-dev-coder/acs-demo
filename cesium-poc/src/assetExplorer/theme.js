/**
 * MUI theme for the Asset Explorer island, in both modes.
 *
 * One configuration with mode-specific tokens rather than two themes: the roles below mirror the
 * CSS custom properties in i595Demo.css exactly, so the React island and the plain-DOM panels stay
 * the same colour by construction instead of by somebody remembering to update both.
 *
 * Semantic colours (success/warning/error) are NOT derived from the surface — an incident is the
 * same red on white as on navy, because the colour carries meaning rather than style.
 */
import { createTheme } from '@mui/material/styles';

/** Surfaces, text and lines per mode — the same roles the stylesheet defines. */
export const UI_TOKENS = Object.freeze({
  dark: Object.freeze({
    surface: '#0f1d31', surfaceRaised: '#17293d', canvas: '#0b1729',
    text: '#e8eef6', textSecondary: '#92a8c3',
    line: '#24344f',
    accent: '#38c9bf', accentBright: '#67f4e2', accentContrast: '#0b1729',
  }),
  light: Object.freeze({
    surface: '#ffffff', surfaceRaised: '#f8fafc', canvas: '#eef2f7',
    text: '#172033', textSecondary: '#5f6b7a',
    line: '#d8dee6',
    // Darkened for legibility on white; the dark mode keeps the brighter corridor teal.
    accent: '#0b6f66', accentBright: '#14a89b', accentContrast: '#ffffff',
  }),
});

/** Status colours, shared by both modes and chosen to read on either surface. */
export const SEMANTIC = Object.freeze({ ok: '#2e8b6a', warning: '#b3631b', danger: '#c0392f' });

export const PALETTE = UI_TOKENS.dark;

export function createAppTheme(mode = 'dark') {
  const token = UI_TOKENS[mode] ?? UI_TOKENS.dark;
  const isLight = mode === 'light';
  return createTheme({
    palette: {
      mode: isLight ? 'light' : 'dark',
      primary: { main: token.accent, light: token.accentBright, contrastText: token.accentContrast },
      background: { default: token.canvas, paper: token.surface },
      text: { primary: token.text, secondary: token.textSecondary },
      divider: token.line,
      success: { main: SEMANTIC.ok },
      warning: { main: SEMANTIC.warning },
      error: { main: SEMANTIC.danger },
      action: {
        hover: isLight ? 'rgba(23,32,51,0.06)' : 'rgba(255,255,255,0.08)',
        selected: isLight ? 'rgba(15,141,130,0.10)' : 'rgba(56,201,191,0.14)',
      },
    },
    shape: { borderRadius: 10 },
    spacing: 8,
    typography: {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      h6: { fontSize: '0.9375rem', fontWeight: 600, letterSpacing: 0 },
      subtitle2: { fontSize: '0.8125rem', fontWeight: 600 },
      body2: { fontSize: '0.8125rem' },
      caption: { fontSize: '0.6875rem', letterSpacing: 0.2 },
      button: { textTransform: 'none', fontWeight: 600, fontSize: '0.8125rem' },
    },
    components: {
      // Panels float over a busy 3D scene, so they separate with a hairline border and a restrained
      // shadow rather than a heavy one — in both modes, for the same reason.
      MuiPaper: {
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundImage: 'none',
            border: `1px solid ${theme.palette.divider}`,
            transition: theme.transitions.create(['background-color', 'border-color', 'color'], { duration: 170 }),
          }),
        },
      },
      MuiButton: { defaultProps: { disableElevation: true, size: 'small' } },
      MuiIconButton: { defaultProps: { size: 'small' } },
      // Material keeps tooltips dark in light mode; that is deliberate, not an oversight.
      MuiTooltip: { defaultProps: { arrow: true, enterDelay: 400 } },
      MuiChip: { styleOverrides: { root: { height: 20, fontSize: '0.6875rem' } } },
    },
  });
}

/** Kept for callers that predate the mode switch. */
export const assetExplorerTheme = createAppTheme('dark');
