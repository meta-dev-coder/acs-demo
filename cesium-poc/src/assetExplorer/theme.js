/**
 * MUI theme for the Asset Explorer island.
 *
 * The app has no theme object to read — it is plain CSS — so the palette is lifted from the values
 * the existing stylesheet actually uses: the corridor teal that already marks selection and
 * interactive state, the deep navy surfaces the panels sit on, and the two text weights. Nothing
 * here is a new brand colour, and components reference theme tokens rather than repeating hexes.
 */
import { createTheme } from '@mui/material/styles';

/** Straight from src/i595Demo.css — the accent, surfaces and text already in use. */
export const PALETTE = Object.freeze({
  accent: '#38c9bf',
  accentBright: '#67f4e2',
  surface: '#0f1d31',
  surfaceDeep: '#0b1729',
  line: '#24344f',
  text: '#e8eef6',
  textMuted: '#92a8c3',
  warning: '#e8963c',
  danger: '#d65a4a',
  ok: '#4caf87',
});

export const assetExplorerTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: PALETTE.accent, light: PALETTE.accentBright, contrastText: PALETTE.surfaceDeep },
    background: { default: PALETTE.surfaceDeep, paper: PALETTE.surface },
    text: { primary: PALETTE.text, secondary: PALETTE.textMuted },
    divider: PALETTE.line,
    success: { main: PALETTE.ok },
    warning: { main: PALETTE.warning },
    error: { main: PALETTE.danger },
  },
  shape: { borderRadius: 10 },
  spacing: 8,
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    // Operations UI: dense and legible, not a marketing page. No oversized display sizes.
    h6: { fontSize: '0.9375rem', fontWeight: 600, letterSpacing: 0 },
    subtitle2: { fontSize: '0.8125rem', fontWeight: 600 },
    body2: { fontSize: '0.8125rem' },
    caption: { fontSize: '0.6875rem', letterSpacing: 0.2 },
    button: { textTransform: 'none', fontWeight: 600, fontSize: '0.8125rem' },
  },
  components: {
    // The island floats over a 3D scene, so surfaces need a real edge to read against it —
    // a hairline border rather than a heavy shadow.
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none', border: `1px solid ${PALETTE.line}` },
      },
    },
    MuiButton: { defaultProps: { disableElevation: true, size: 'small' } },
    MuiIconButton: { defaultProps: { size: 'small' } },
    MuiTooltip: { defaultProps: { arrow: true, enterDelay: 400 } },
    MuiChip: { styleOverrides: { root: { height: 20, fontSize: '0.6875rem' } } },
  },
});
