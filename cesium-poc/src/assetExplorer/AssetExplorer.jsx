/**
 * The Asset Explorer island: bottom carousel, corridor rail, mini-map and details panel.
 *
 * All four read one selection from the store and write back through one `selectAsset`, so a Cesium
 * pick, a card, a mini-map marker and Next are the same operation arriving from different places.
 *
 * Layout awareness (§19): the bottom bar and the mini-map both reserve room for the details panel
 * when it is open, so nothing is ever parked underneath it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Chip, IconButton, Paper, Stack, ThemeProvider, Tooltip, Typography, useMediaQuery } from '@mui/material';
import CssBaseline from '@mui/material/CssBaseline';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { createAppTheme } from './theme.js';
import { useAssetStore } from './useAssetStore.js';
import { assetTypeConfig } from './assetTypes.js';
import { corridorLengthMiles } from './corridorPosition.js';
import { SELECTION_SOURCES } from './assetSelectionStore.js';
import { AssetCarousel } from './AssetCarousel.jsx';
import { AssetPositionRail } from './AssetPositionRail.jsx';
import { AssetMiniMap } from './AssetMiniMap.jsx';
import { AssetDetailsPanel, DETAILS_WIDTH } from './AssetDetailsPanel.jsx';

/** Below this the mini-map stops earning its space and the details panel becomes an overlay. */
export const MINIMAP_MIN_WIDTH = 1100;
/** Three cards plus the two step buttons; beyond this the bar is just covering the map. */
export const EXPLORER_MAX_WIDTH = 720;
/** Sits close to the bottom edge now that no status strip runs beneath it. */
export const BOTTOM_OFFSET = 20;

export function AssetExplorer({ store, centerline, leftInset = 16, themeMode = 'dark', onInspect, onReturn, onViewCamera }) {
  const state = useAssetStore(store);
  // Rebuilt only when the mode actually changes; a new theme object on every render would remount
  // every styled node in the island.
  const theme = useMemo(() => createAppTheme(themeMode), [themeMode]);
  const { activeExplorerType, selectedAsset, explorerExpanded, detailsOpen, inspectionViewActive } = state;
  const showMiniMap = useMediaQuery(`(min-width:${MINIMAP_MIN_WIDTH}px)`);
  const compact = useMediaQuery('(max-width:820px)');

  const config = activeExplorerType ? assetTypeConfig(activeExplorerType) : null;
  const assets = state.assetsByType[activeExplorerType] ?? [];
  const status = state.statusByType[activeExplorerType] ?? { loading: false, error: null };
  const corridorMiles = useMemo(() => corridorLengthMiles(centerline), [centerline]);

  // The mini-map should be exactly as tall as the browser beside it. Its height is not a constant —
  // it changes with the collapse toggle and with how the cards wrap — so it is measured rather than
  // guessed at, and the canvas is told what to draw into.
  const [explorerHeight, setExplorerHeight] = useState(0);
  const observerRef = useRef(null);
  // A callback ref rather than an effect: this component renders null until a layer is switched on,
  // so an effect on mount would observe nothing and never look again.
  const explorerRef = useCallback(node => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setExplorerHeight(Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height));
    });
    observer.observe(node);
    observerRef.current = observer;
    setExplorerHeight(Math.round(node.getBoundingClientRect().height));
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const select = useCallback((asset, source) => { store.selectAsset(asset, source); }, [store]);
  const selectFromCard = useCallback(asset => select(asset, SELECTION_SOURCES.CARD), [select]);
  const selectFromMiniMap = useCallback(asset => select(asset, SELECTION_SOURCES.MINIMAP), [select]);
  const selectFromRail = useCallback(asset => select(asset, SELECTION_SOURCES.RAIL), [select]);
  const step = useCallback(delta => { store.step(delta); }, [store]);

  if (!config) return null;

  // Reserve the details panel's column so the bottom bar never slides underneath it.
  // A type that keeps its own details panel gets no second one here; two panels describing the
  // same asset is worse than either alone.
  const detailsShowing = detailsOpen && Boolean(selectedAsset) && !config.legacyDetailsPanel;
  // The bottom group keeps a fixed position: selecting an asset must not slide the browser out from
  // under the cursor. It can afford to, because the mini-map sits to the LEFT of the browser — the
  // only thing that reaches toward the details panel is the browser's own right edge, and a centred
  // browser of EXPLORER_MAX_WIDTH stops well short of it. The panel's width is still subtracted
  // when the Map Explorer is also open, which is the one case where the two could otherwise meet.
  const rightInset = detailsShowing && !compact && leftInset > 16 ? DETAILS_WIDTH + 32 : 16;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme={false} />
      {/* The island covers the map, so it must not intercept pointer events except on its own
          surfaces — Cesium navigation has to keep working around it. */}
      <Box sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 12 }}>
        {detailsShowing && (
          <AssetDetailsPanel
            asset={selectedAsset}
            inspecting={inspectionViewActive}
            onClose={() => store.setDetailsOpen(false)}
            onInspect={onInspect}
            onReturn={onReturn}
            onViewCamera={onViewCamera}
          />
        )}

        {/* One bottom navigation group. The browser and the mini-map stay separate Material
            surfaces, but they are a single workspace: this container owns the bottom offset, the
            horizontal alignment and the gap, and neither child positions itself. Its left and right
            edges are the Map Explorer and the details panel, so the pair centres on the Cesium
            workspace that is actually free rather than on the browser window. */}
        <Box
          sx={{
            position: 'absolute', left: leftInset, right: rightInset, bottom: BOTTOM_OFFSET,
            // Three columns rather than a centred row: the middle column holds the browser, so the
            // browser itself is centred on the workspace. A flex row would centre the PAIR, which
            // pushes the browser right of centre by half the mini-map's width.
            // The middle column is pinned rather than `auto`: an auto column is sized by its
            // content, so the selected card's 2px border was enough to re-measure it and make the
            // browser visibly change width on every selection.
            display: 'grid',
            gridTemplateColumns: `1fr minmax(0, ${EXPLORER_MAX_WIDTH}px) 1fr`,
            alignItems: 'end', gap: 1.5,
            pointerEvents: 'none',
            // The workspace changes width when the details panel or the Map Explorer opens; easing
            // it keeps the group from appearing to jump sideways.
            transition: theme => theme.transitions.create(['left', 'right'], { duration: 180 }),
          }}
        >
          {/* Column 1, pushed to its right edge so it sits immediately beside the browser. */}
          <Box sx={{ justifySelf: 'end', pointerEvents: 'auto' }}>
            {showMiniMap && explorerExpanded && (
              <AssetMiniMap
                centerline={centerline}
                assets={assets}
                selectedAsset={selectedAsset}
                onSelect={selectFromMiniMap}
                height={explorerHeight}
              />
            )}
          </Box>

          <Paper
            ref={explorerRef}
            elevation={6}
            // The browser gives up width first as the workspace narrows; the mini-map keeps its
            // size until the breakpoint drops it entirely.
            sx={{ width: '100%', minWidth: 0, maxWidth: EXPLORER_MAX_WIDTH, pointerEvents: 'auto', overflow: 'hidden' }}
            role="region"
            aria-label={`${config.label} explorer`}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1.5, py: 1 }}>
              <Typography variant="h6">{config.label}</Typography>
              <Chip
                label={status.loading ? '…' : `${assets.length.toLocaleString('en-US')} ${assets.length === 1 ? 'asset' : 'assets'}`}
                size="small" variant="outlined"
              />
              <Box sx={{ flex: 1 }} />
              <Tooltip title={explorerExpanded ? 'Collapse' : 'Expand'}>
                <IconButton
                  onClick={() => store.setExplorerExpanded(!explorerExpanded)}
                  aria-label={explorerExpanded ? `Collapse ${config.label} explorer` : `Expand ${config.label} explorer`}
                  aria-expanded={explorerExpanded}
                >
                  {explorerExpanded ? <ExpandMoreIcon /> : <ExpandLessIcon />}
                </IconButton>
              </Tooltip>
              <Tooltip title="Close explorer">
                <IconButton onClick={() => store.setActiveExplorerType(null)} aria-label={`Close ${config.label} explorer`}>
                  <CloseIcon />
                </IconButton>
              </Tooltip>
            </Stack>
            {explorerExpanded && (
              <>
                <AssetCarousel
                  assets={assets}
                  selectedAsset={selectedAsset}
                  singular={config.singular}
                  status={status}
                  emptyMessage={config.emptyMessage}
                  errorMessage={config.errorMessage}
                  onSelect={selectFromCard}
                  onStep={step}
                />
                <AssetPositionRail
                  assets={assets}
                  selectedId={selectedAsset?.id ?? null}
                  corridorMiles={corridorMiles}
                  onSelect={selectFromRail}
                />
              </>
            )}
          </Paper>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
